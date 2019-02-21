'use strict';

const DEBUG = process.env.DEBUG === '1';
if (DEBUG) {
    require('inspector').open(9229, '0.0.0.0', false);
}

const normalize = require('./normalize');
const Homey = require('homey');
const { HomeyAPI } = require('athom-api');
const MQTTClient = require('./mqtt/MQTTClient');
const MessageQueue = require('./mqtt/MessageQueue');
const Message = require('./mqtt/Message');
const TopicsRegistry = require('./mqtt/TopicsRegistry');

// Services
const Log = require("./Log.js");
const DeviceManager = require("./DeviceManager.js");

// Dispatchers
const SystemStateDispatcher = require("./dispatchers/SystemStateDispatcher.js");
const HomieDispatcher = require("./dispatchers/HomieDispatcher.js");
const HomeAssistantDispatcher = require("./dispatchers/HomeAssistantDispatcher.js");

// Commands
const CommandHandler = require("./commands/CommandHandler.js");

// Birth & Last will
const BIRTH_TOPIC = '{deviceId}/hub/status'; // NOTE: Empty to ommit
const BIRTH_MESSAGE = 'online';
const WILL_TOPIC = '{deviceId}/hub/status'; // NOTE: Empty to ommit
const WILL_MESSAGE = 'offline';

class MQTTHub extends Homey.App {

    async onInit() {
        try {
            Log.info('MQTT Hub is running...');

            Homey.on('unload', () => this.uninstall());

            this.settings = Homey.ManagerSettings.get('settings') || {};

            Log.debug(this.settings, false, false);

            this.api = await HomeyAPI.forCurrentHomey();

            try {
                this.system = await this._getSystemInfo();
            } catch (e) {
                Log.error('[boot] Failed to fetch system info');
                Log.error(e);
                this.system = {};
            }

            Log.debug("Update settings");
            this.updateSettings();

            Log.debug("Initialize MQTT Client & Message queue");
            this.mqttClient = new MQTTClient();
            this.messageQueue = new MessageQueue(this.mqttClient);
            this.topicsRegistry = new TopicsRegistry(this.messageQueue);

            // Suppress memory leak warning
            Log.debug("Suppress memory leak warning");
            this.api.devices.setMaxListeners(9999); // HACK

            // devices
            Log.debug("Initialize DeviceManager");
            this.deviceManager = new DeviceManager(this);

            Log.debug("Register DeviceManager");
            await this.deviceManager.register();

            // run
            Log.debug("Launch!");
            await this.start();
        }
        catch (e) {
            Log.error('[boot] Failed to initialize app');
            Log.error(e);
        }
    }

    updateSettings() {
        const systemName = this.system.name || 'Homey';
        if (this.settings.deviceId === undefined || this.settings.systemName !== systemName || this.settings.topicRoot) {

            // Backwards compatibility
            if (this.settings.topicRoot && !this.settings.homieTopic) {
                this.settings.homieTopic = this.settings.topicRoot;
                delete this.settings.topicRoot;
            }

            this.settings.systemName = systemName;
            this.settings.deviceId = this.settings.deviceId || this.settings.systemName;
            Log.debug("Settings initial deviceId: " + this.settings.deviceId);
            Homey.ManagerSettings.set('settings', this.settings);
            Log.debug("Settings updated");
        }
    }

    async start() {
        try {
            Log.info('app start');
            await this.mqttClient.connect();
            this._sendBirthMessage();
            this._startCommands();
            this._startBroadcasters();

            const protocol = this.settings.protocol || 'homie3';
            if (this.protocol !== protocol) {
                Log.info("Changing protocol from '" + this.protocol + "' to '" + protocol + "'");
                this._stopCommunicationProtocol(this.protocol);
                await this._startCommunicationProtocol(protocol);
            }

            Log.info('app running: true');
        } catch (e) {
            Log.error('Failed to start app');
            Log.error(e);
        }
    }

    stop() {
        this._sendLastWillMessage();
        Log.info('app stop');
        this.mqttClient.disconnect();
        this._stopCommands();
        this._stopBroadcasters();
        this._stopCommunicationProtocol();
        delete this.protocol;

        // TODO: Unsubscribe all topics

        Log.info('app running: false');
    }
    
    async _startCommunicationProtocol(protocol) {
        this.protocol = protocol || this.protocol;
        Log.info('start communication protocol: ' + this.protocol);

        // NOTE: All communication is based on the (configurable) Homie Convention...
        this.homieDispatcher = new HomieDispatcher(this);

        // Enable Home Assistant Discovery
        // TODO: Make HomeAssistantDispatcher configurable
        this.homeAssistantDispatcher = new HomeAssistantDispatcher(this);
        await this.homeAssistantDispatcher.register();

        // Register all devices & dispatch current state
        this.homieDispatcher.register();
    }

    _stopCommunicationProtocol(protocol) {
        protocol = protocol || this.protocol;

        if (protocol) {

            Log.info('stop communication protocol: ' + this.protocol);

            // NOTE: All communication is based on the (configurable) Homie Convention...
            if (this.homieDispatcher) {
                this.homieDispatcher.destroy();
                delete this.homieDispatcher;
            }

            // Disable Home Assistant Discovery
            if (this.homeAssistantDispatcher) {
                this.homeAssistantDispatcher.destroy();
                delete this.homeAssistantDispatcher;
            }
        }
    }

    _startCommands() {
        this._stopCommands();
        this.commandHandler = new CommandHandler(this); // TODO: Refactor command handler with the abillity to register commands
    }
    _stopCommands() {
        if (this.commandHandler) {
            this.commandHandler.destroy();
            delete this.commandHandler;
        }
    }

    _startBroadcasters() {
        Log.info("start broadcasters");
        if (this.homieDispatcher) {
            const broadcast = this.settings.broadcastDevices !== false;
            Log.info("homie dispatcher broadcast: " + broadcast);
            this.homieDispatcher.broadcast = broadcast;
        }

        if (this.homeAssistantDispatcher) {
            const broadcast = this.settings.broadcastDevices !== false;
            Log.info("Home Assistant dispatcher broadcast: " + broadcast);
            this.homeAssistantDispatcher.broadcast = broadcast;
        }

        if (!this.systemStateDispatcher && this.settings.broadcastSystemState) {
            Log.info("start system dispatcher");
            this.systemStateDispatcher = new SystemStateDispatcher(this);
        }
    }

    _stopBroadcasters() {
        Log.info("stop broadcasters");
        if (this.homieDispatcher) {
            Log.info("stop homie dispatcher");
            this.homieDispatcher.broadcast = false;
        }

        if (this.homeAssistantDispatcher) {
            Log.info("stop Home Assistant dispatcher");
            this.systemStateDispatcher.broadcast = false;
        }

        if (this.systemStateDispatcher) {
            Log.info("stop system dispatcher");
            this.systemStateDispatcher.destroy()
                .then(() => Log.info("Failed to destroy SystemState Dispatcher"))
                .catch(error => Log.error(error));
            delete this.systemStateDispatcher;
        }
    }

    async _getSystemInfo() {
        Log.info("get system info");
        const info = await this.api.system.getInfo();
        return {
            name: info.hostname,
            version: info.homey_version
        };
    }

    async getDevices() {
        try {
            Log.info("get devices");
            if (this.deviceManager && this.deviceManager.devices)
                return this.deviceManager.devices;

            const api = await HomeyAPI.forCurrentHomey();
            return await api.devices.getDevices();
        } catch (e) {
            Log.error("Failed to get Homey's devices");
            Log.error(e);
        }
    }

    async getZones() {
        try {
            Log.info("get zones");
            if (this.deviceManager && this.deviceManager.zones)
                return this.deviceManager.zones;

            const api = await HomeyAPI.forCurrentHomey();
            return await api.zones.getZones();
        } catch (e) {
            Log.error("Failed to get Homey's zones");
            Log.error(e);
        }
    }

    isRunning() {
        return this.mqttClient && this.mqttClient.isRegistered() && !this.pause;
    }

    setRunning(running) {
        Log.info(running ? 'switch on' : 'switch off');
        if (this.mqttClient) {
            if (running) {
                this.start()
                    .then(() => Log.info("App running"))
                    .catch(error => Log.error(error));
            }
            else {
                this.stop();
            }
        }
    }

    /**
     * Publish all device states
     * */
    refresh() {
        Log.info('refresh');
        if (this.homeAssistantDispatcher) {
            this.homeAssistantDispatcher.dispatchState();
        }
        if (this.homieDispatcher) {
            this.homieDispatcher.dispatchState();
        }
    }

    async settingsChanged() {
        try {
            Log.info("Settings changed");
            this.settings = Homey.ManagerSettings.get('settings') || {};
            Log.debug(this.settings);

            // devices
            let deviceChanges = null;
            if (this.deviceManager) {
                deviceChanges = this.deviceManager.computeChanges(this.settings.devices);
                this.deviceManager.setEnabledDevices(this.settings.devices);
            }

            if (this.homieDispatcher) {
                this.homieDispatcher.updateSettings(this.settings, deviceChanges);
            }

            if (this.homeAssistantDispatcher) {
                this.homeAssistantDispatcher.updateSettings(this.settings, deviceChanges);
            }

            // clean-up all messages for disabled devices
            for (let deviceId of deviceChanges.disabled) {
                if (typeof deviceId === 'string') {
                    this.topicsRegistry.remove(deviceId, true);
                }
            }

            // protocol, broadcasts
            await this.start(); // NOTE: Changes are detected in the start method(s)
        } catch (e) {
            Log.error("Failed to update settings");
            Log.error(e);
        }
    }

    _sendBirthMessage() {
        if (this.mqttClient && BIRTH_TOPIC && BIRTH_MESSAGE) {
            const deviceId = this.settings && this.settings.deviceId ? this.settings.deviceId : 'Homey';
            const topic = BIRTH_TOPIC.replace('{deviceId}', deviceId);
            this.mqttClient.publish(new Message(topic, BIRTH_MESSAGE, 1, true));
        }
    }
    _sendLastWillMessage() {
        if (this.mqttClient && WILL_TOPIC && WILL_MESSAGE) {
            const deviceId = this.settings && this.settings.deviceId ? this.settings.deviceId : 'Homey';
            const topic = WILL_TOPIC.replace('{deviceId}', deviceId);
            this.mqttClient.publish(new Message(topic, WILL_MESSAGE, 1, true));
        }
    }

    uninstall() {
        try {
            this._sendLastWillMessage();
            this.mqttClient.disconnect();
            // TODO: unregister topics from MQTTClient?
        } catch(e) {
            // nothing...
        }
    }
}

module.exports = MQTTHub;