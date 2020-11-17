/* eslint-disable max-classes-per-file */
/* globals BigInt */
const net = require("net");
const { inflateSync } = require("zlib");
const protobuf = require("protobufjs");
const root = protobuf.Root.fromJSON(require("../../schema.json"));
const Logger = require("../Logger");
const entities = require("../entities");
const { EventEmitter } = require("events");
const { Readable } = require("stream");
/** @type {any} */
const assert = require("assert");

const { map: { ValetudoMap, MapLayer, PointMapEntity, PathMapEntity } } = entities;
const { RobotState, attributes: { BatteryStateAttribute, StatusStateAttribute, FanSpeedStateAttribute, LatestCleanupStatisticsAttribute } } = entities.state;
const BATTERY_FLAG = BatteryStateAttribute.FLAG;
const STATUS_STATE_FLAG = StatusStateAttribute.FLAG;
const STATUS_STATE_VALUE = StatusStateAttribute.VALUE;
const FAN_SPEED_STATE_VALUE = FanSpeedStateAttribute.VALUE;
const LATEST_CLEANUP_STATISTICS_TYPE = LatestCleanupStatisticsAttribute.TYPE;
const BATTERY_MAX = 200;

const OPCODES = {
    "QMSG_DEVICE_LOGIN": 0x07D1,
    "RMSG_DEVICE_LOGIN": 0x07D2,
    "QMSG_PING": 0x07D5,
    "RMSG_PING": 0x07D6,
    "QMSG_DEVICE_SIGNUP": 0x0FA1,
    "RMSG_DEVICE_SIGNUP": 0x0FA2,
    "QMSG_DEVICE_TIME": 0x1011,
    "RMSG_DEVICE_TIME": 0x1012,
    "QMSG_RETURN_HOME": 0x1069,
    "RMSG_RETURN_HOME": 0x106A,
    "QMSG_CLEAN_AREA": 0x106B,
    "RMSG_CLEAN_AREA": 0x106C,
    "QMSG_CLEAN_MODE": 0x106D,
    "RMSG_CLEAN_MODE": 0x106E,
    "QMSG_DEVICE_CHECK": 0x1079,
    "RMSG_DEVICE_CHECK": 0x107A,
    "QMSG_SET_FAN_MODE": 0x10D9,
    "RMSG_SET_FAN_MODE": 0x10DA,
    "QMSG_CONNECT_DEVICE": 0x1009,
    "QMSG_DEVICE_STATUS": 0x10FE,
    "QMSG_LOCATE_DEVICE": 0X10EB,
    "RMSG_LOCATE_DEVICE": 0X10EC,
    "QMSG_SET_AREA": 0x1101,
    "RMSG_SET_AREA": 0x1102,
    "QMSG_SET_POSITION": 0x1103,
    "RMSG_SET_POSITION": 0x1104,
    "QMSG_UNK2": 0x111f,
    "RMSG_UNK2": 0x1120,
    "QMSG_MAP_INFO": 0x1162,
    "RMSG_MAP_INFO": 0x1163,
    "RMSG_MAP_UPDATE": 0x1164,
    "RMSG_UPDATE_ROBOT_POSITION": 0x1166,
    "RMSG_UPDATE_CHARGE_POSITION": 0x1168,
    "RMSG_AREA_LIST_INFO": 0x116A,
    "QMSG_UNK1": 0x119A,
    "RMSG_UNK1": 0x119B,
    "QMSG_DEVICE_VERSION": 0x119C,
    "RMSG_DEVICE_VERSION": 0x119D,
    "QMSG_DEVICE_OTA": 0x1461,
    "RMSG_DEVICE_OTA": 0x1462,
    "QMSG_DEVICE_INFO": 0x1465,
    "RMSG_DEVICE_INFO": 0x1466,
    "QMSG_BATTERY_LEVEL": 0x146f,
    "RMSG_BATTERY_LEVEL": 0x1470,
};

const COMMANDS = {
    LOCATE_DEVICE: ["QMSG_LOCATE_DEVICE", "RMSG_LOCATE_DEVICE"],
    RETURN_HOME: ["QMSG_RETURN_HOME", "RMSG_RETURN_HOME"],
    CLEAN_MODE: ["QMSG_CLEAN_MODE", "RMSG_CLEAN_MODE"],
    SET_FAN_MODE: ["QMSG_SET_FAN_MODE", "RMSG_SET_FAN_MODE"],
    MAP_INFO: ["QMSG_MAP_INFO", "RMSG_MAP_INFO"],
    SET_POSITION: ["QMSG_SET_POSITION", "RMSG_SET_POSITION"],
    UNK2: ["QMSG_UNK2", "RMSG_UNK2"],
    DEVICE_TIME: ["QMSG_DEVICE_TIME", "RMSG_DEVICE_TIME"],
    DEVICE_CHECK: ["QMSG_DEVICE_CHECK", "RMSG_DEVICE_CHECK"],
    SET_AREA: ["QMSG_SET_AREA", "RMSG_SET_AREA"],
    CLEAN_AREA: ["QMSG_CLEAN_AREA", "RMSG_CLEAN_AREA"],
};

/**
 * @param {object} obj
 * @returns {object}
 */
function flip(obj) {
    return Object.entries(obj).reduce((acc, [key, value]) => {
        acc[value] = key;
        return acc;
    }, {});
}

const OPNAMES = flip(OPCODES);

const OPCODE_HANDLERS = {
    "RMSG_UPDATE_ROBOT_POSITION": handleUpdateRobotPosition,
    "RMSG_UPDATE_CHARGE_POSITION": handleUpdateChargePosition,
    "RMSG_MAP_INFO": handleMap,
    "RMSG_MAP_UPDATE": handleMap,
    "RMSG_AREA_LIST_INFO": handleAreaListInfo,
};

/**
 * @param {Buffer} buffer
 * @returns {Readable}
 */
function toStream(buffer) {
    return Readable.from(buffer, { objectMode: false });
}

/**
 * @param {number} size
 * @param {keyof Buffer} method
 */
function readFn(size, method) {
    return (stream) => {
        const buffer = stream.read(size);

        assert(buffer, `read(${size}): empty value from stream`);

        return buffer[method]();
    };
}

const readByte = readFn(1, "readUInt8");
const readShort = readFn(2, "readUInt16LE");
const readWord = readFn(4, "readUInt32LE");
const readFloat = readFn(4, "readFloatLE");
const readLong = readFn(8, "readBigUInt64LE");

/**
 * @param {Readable} stream
 * @returns {string}
 */
function readString(stream) {
    const length = readByte(stream);

    if (length) {
        return stream.read(length).toString("utf8");
    }

    return "";
}

/**
 * @typedef {object} MapInfo
 * @property {number} mapHeadId
 * @property {string} mapName
 * @property {number} currentPlanId
 */

/**
 * @param {Readable} stream
 * @returns {MapInfo[]}
 */
function readMapInfoList(stream) {
    const size = readByte(stream);
    const list = [];

    for (let i = 0; i < size; i++) {
        list.push({
            mapHeadId: readWord(stream),
            mapName: readString(stream),
            currentPlanId: readWord(stream),
        });
    }

    return list;
}

function readCleanRoomList(stream) {
    const size = readWord(stream);
    const list = [];

    for (let i = 0; i < size; i++) {
        list.push({
            roomId: readByte(stream),
            roomName: readString(stream),
            roomState: readByte(stream),
            roomX: readFloat(stream),
            roomY: readFloat(stream),
        });
    }

    return list;
}

function readAreaInfoList(stream) {
    const size = readWord(stream);
    const list = [];

    for (let i = 0; i < size; i++) {
        const areaInfo = {
            areaId: readWord(stream),
            areaType: readWord(stream),
            points: readWord(stream),
        };

        if (areaInfo.points) {
            areaInfo.x = new Array(areaInfo.points).fill(0).map(() => readFloat(stream));
            areaInfo.y = new Array(areaInfo.points).fill(0).map(() => readFloat(stream));
            areaInfo.unk1 = new Array(areaInfo.points).fill(0).map(() => readFloat(stream));
            areaInfo.unk2 = new Array(areaInfo.points).fill(0).map(() => readFloat(stream));
            areaInfo.unk3 = new Array(areaInfo.points).fill(0).map(() => readFloat(stream));
        }

        list.push(areaInfo);
    }

    return list;
}

function readCleanRoomInfoList(stream) {
    const size = readWord(stream);
    const list = [];

    for (let i = 0; i < size; i++) {
        list.push({
            infoId: readByte(stream),
            infoType: readByte(stream),
        });
    }

    return list;
}

function readCleanPlanList(stream) {
    const size = readByte(stream);
    const list = [];

    for (let i = 0; i < size; i++) {
        list.push({
            planId: readWord(stream),
            planName: readString(stream),
            mapHeadId: readWord(stream),
            unk1: readWord(stream),
            areaInfoList: readAreaInfoList(stream),
            cleanRoomInfoList: readCleanRoomInfoList(stream),
        });
    }

    return list;
}

function handleUpdateRobotPosition(payload) {
    const stream = toStream(payload);

    return {
        mapHeadId: readWord(stream),
        poseId: readWord(stream),
        update: readByte(stream),
        poseX: readFloat(stream),
        poseY: readFloat(stream),
        posePhi: readFloat(stream),
    };
}

function handleUpdateChargePosition(payload) {
    const stream = toStream(payload);

    return {
        poseId: readWord(stream),
        poseX: readFloat(stream),
        poseY: readFloat(stream),
        posePhi: readFloat(stream),
    };
}

function readMapHeadInfo(stream) {
    return {
        mapHeadId: readWord(stream),
        mapValid: readWord(stream),
        mapType: readWord(stream),
        sizeX: readWord(stream),
        sizeY: readWord(stream),
        minX: readFloat(stream),
        minY: readFloat(stream),
        maxX: readFloat(stream),
        maxY: readFloat(stream),
        resolution: readFloat(stream),
    };
}

function readCleanPlanInfo(stream) {
    return {
        mapHeadId: readWord(stream),
        mask: readShort(stream),
        firstCleanFlag: readByte(stream),
    };
}

function handleMap(payload) {
    const buffer = inflateSync(payload);
    const stream = toStream(buffer);
    const data = {};

    data.mask = readWord(stream);

    if (data.mask & 0x1) {
        data.statusInfo = {
            mapHeadId: readWord(stream),
            hasHistoryMap: readWord(stream),
            workingMode: readWord(stream),
            batteryPercent: readWord(stream),
            chargeState: readWord(stream),
            faultType: readWord(stream),
            faultCode: readWord(stream),
            cleanPreference: readWord(stream),
            repeatClean: readWord(stream),
            cleanTime: readWord(stream),
            cleanSize: readWord(stream),
        };
    }

    if (data.mask & 0x2) {
        data.mapHeadInfo = readMapHeadInfo(stream);
        data.mapGrid = stream.read(data.mapHeadInfo.sizeX * data.mapHeadInfo.sizeY);
    }

    if (data.mask & 0x4) {
        data.historyHeadInfo = {
            mapHeadId: readWord(stream),
            pointNumber: readWord(stream),
            poseId: readWord(stream),
        };

        // dump history bytes
        data.pointUnk = stream.read(data.historyHeadInfo.pointNumber * 9);
    }

    if (data.mask & 0x8) {
        data.robotChargeInfo = {
            mapHeadId: readWord(stream),
            poseX: readFloat(stream),
            poseY: readFloat(stream),
            posePhi: readFloat(stream),
        };
    }

    if (data.mask & 0x10) {
        data.wallListInfo = {
            mapHeadId: readWord(stream),
            cleanPlanId: readWord(stream),
            areaCount: readWord(stream),
        };
    }

    if (data.mask & 0x20) {
        data.areaListInfo = {
            mapHeadId: readWord(stream),
            cleanPlanId: readWord(stream),
            areaCount: readWord(stream),
        };
    }

    if (data.mask & 0x40) {
        data.spotInfo = {
            mapHeadId: readWord(stream),
            ctrlValue: readWord(stream),
            poseX: readFloat(stream),
            poseY: readFloat(stream),
            posePhi: readFloat(stream),
        };
    }

    if (data.mask & 0x80) {
        data.robotPoseInfo = {
            mapHeadId: readWord(stream),
            poseId: readWord(stream),
            update: readByte(stream),
            poseX: readFloat(stream),
            poseY: readFloat(stream),
            posePhi: readFloat(stream),
        };
    }

    if (data.mask & 0x100) {
        throw new Error("handleMap: unhandled mask 0x100");
    }

    if (data.mask & 0x200) {
        throw new Error("handleMap: unhandled mask 0x200");
    }

    if (data.mask & 0x400) {
        throw new Error("handleMap: unhandled mask 0x400");
    }

    if (data.mask & 0x800) {
        data.cleanPlanInfo = readCleanPlanInfo(stream);
    }

    if (data.mask & 0x1000) {
        data.mapInfoList = readMapInfoList(stream);
    }

    if (data.mask & 0x2000) {
        data.cleanRoomList = readCleanRoomList(stream);
        data.cleanPlanList = readCleanPlanList(stream);
        data.totalRooms = data.cleanRoomList.length;

        // dump rooms
        data.unkRooms = stream.read(data.totalRooms * data.totalRooms);

        data.roomEnableInfo = {
            mapHeadId: readWord(stream),
            size: readByte(stream),
        };

        if (data.roomEnableInfo.size) {
            throw new Error("handleMap: unhandled room enable info");
        }
    }

    return data;
}

function handleAreaListInfo(payload) {
    const buffer = inflateSync(payload);
    const stream = toStream(buffer);
    const data = {};

    data.unk1 = {
        unk1: readWord(stream),
        mapHeadId: readWord(stream),
        unk2: readWord(stream),
        unk3: readWord(stream)
    };

    data.mapHeadInfo = {
        mapHeadId: readWord(stream),
        mapValid: readWord(stream),
        mapType: readWord(stream),
        sizeX: readWord(stream),
        sizeY: readWord(stream),
        minX: readFloat(stream),
        minY: readFloat(stream),
        maxX: readFloat(stream),
        maxY: readFloat(stream),
        resolution: readFloat(stream),
    };
    data.mapGrid = stream.read(data.mapHeadInfo.sizeX * data.mapHeadInfo.sizeY);

    data.cleanPlanInfo = {
        mapHeadId: readWord(stream),
        mask: readShort(stream),
        firstCleanFlag: readByte(stream),
    };

    data.mapInfoList = readMapInfoList(stream);
    data.cleanRoomList = readCleanRoomList(stream);
    data.cleanPlanList = readCleanPlanList(stream);

    return data;
}

/**
 * @typedef {object} PacketData
 * @property {number} size
 * @property {number} ctype
 * @property {number} flow
 * @property {number} deviceId
 * @property {number} userId
 * @property {number} sequence
 * @property {number} opcode
 * @property {Buffer} payload
 */

/**
 * @param {Buffer} data
 * @returns {PacketData}
 */
function unpack(data) {
    const stream = toStream(data);
    const size = readWord(stream);

    assert(data.length >= size, "unpack: missing data");

    return {
        size,
        ctype: readByte(stream),
        flow: readByte(stream),
        deviceId: readWord(stream),
        userId: readWord(stream),
        sequence: readLong(stream),
        opcode: readShort(stream),
        payload: stream.read(size - 24),
    };
}

/**
 * @param {Packet} packet
 * @returns {Buffer}
 */
function pack(packet) {
    const size = 24 + packet.payload.length;
    const data = Buffer.alloc(24);
    let offset = 0;

    offset = data.writeUInt32LE(size, offset);
    offset = data.writeUInt8(packet.ctype, offset);
    offset = data.writeUInt8(packet.flow, offset);
    offset = data.writeUInt32LE(packet.userId, offset);
    offset = data.writeUInt32LE(packet.deviceId, offset);
    offset = data.writeBigUInt64LE(BigInt(packet.sequence), offset);
    data.writeUInt16LE(packet.opcode, offset);

    return Buffer.concat([data, packet.payload]);
}

function filterProperties(_, value) {
    if (value && value.type === "Buffer") {
        return "Buffer";
    }

    return value;
}

class Packet {
    static fromBuffer(buffer) {
        return new Packet(unpack(buffer));
    }

    constructor({ ctype, flow, deviceId, userId, sequence, opcode, payload }) {
        this.ctype = ctype;
        this.flow = flow;
        this.deviceId = deviceId;
        this.userId = userId;
        this.sequence = sequence;
        this.opcode = opcode;
        this.payload = payload;
    }

    get opname() {
        return OPNAMES[this.opcode];
    }

    set opname(opname) {
        this.opcode = OPCODES[opname];
    }

    get data() {
        if (!this.opname) {
            return null;
        }

        if (this.payload) {
            if (root[this.opname]) {
                const schema = root.lookupType(this.opname);
                const message = schema.decode(this.payload);

                return schema.toObject(message);
            } else if (OPCODE_HANDLERS[this.opname]) {
                return OPCODE_HANDLERS[this.opname](this.payload);
            }
        }

        return null;
    }

    set data(data) {
        if (!data) {
            this.payload = Buffer.alloc(0);
            return;
        }

        const schema = root.lookupType(this.opname);
        const err = schema.verify(data);

        assert(!err, `Message.data: ${err}`);

        const message = schema.create(data);

        this.payload = schema.encode(message).finish();
    }

    clone() {
        return new Packet(this.toJSON());
    }

    toBuffer() {
        return pack(this);
    }

    toJSON() {
        const { ctype, flow, deviceId, userId, sequence, opcode, payload } = this;

        return { ctype, flow, deviceId, userId, sequence, opcode, payload };
    }

    toString() {
        const data = this.data;

        return [
            `[S: ${this.sequence.toString(16)}]`,
            `[F: ${this.flow}]`,
            `[${this.opname || this.opcode.toString(16)}]`,
            `[U: ${this.userId}]`,
            `[D: ${this.deviceId}]`,
            data ? JSON.stringify(data, filterProperties) : (this.payload ? this.payload.toString("hex") : "")
        ].join(" ");
    }
}

class Builder {
    constructor() {
        this.userId = 0;
        this.deviceId = 0;
        this.ctype = 2;
        this.sequence = 0;
    }

    setUserId(userId) {
        this.userId = userId;
    }

    setDeviceId(deviceId) {
        this.deviceId = deviceId;
    }

    build(opname, data) {
        const packet = new Packet({
            ctype: this.ctype,
            flow: 0,
            deviceId: this.deviceId,
            userId: this.userId,
            sequence: this.sequence++,
            opcode: null,
            payload: null,
        });

        packet.opname = opname;
        packet.data = data;

        return packet;
    }
}

class Message {
    constructor(socket, packet) {
        this.socket = socket;
        this.packet = packet;
    }

    send() {
        const data = this.packet.toBuffer();

        Logger.debug(`[P: ${this.socket.localPort}] ${this.packet}`);

        // Maybe throw on error?
        if (this.socket.writable) {
            this.socket.write(data);
        }
    }

    buildResponse(opname, data) {
        const packet = this.packet.clone();

        packet.opname = opname;
        packet.data = data;
        packet.flow += 1;

        return new Message(this.socket, packet);
    }
}

class Device {
    constructor(device) {
        this.id = device.id;
        this.deviceSerialNumber = device.deviceSerialNumber;
        this.softwareVersion = device.softwareversion;
    }
}

class Client extends EventEmitter {
    constructor(socket) {
        super();

        this.buffer = Buffer.alloc(0);
        this.builder = new Builder();
        this.socket = socket;
        this.socket.on("data", this.onData.bind(this));
    }

    destroy() {
        this.socket.destroy();
    }

    onData(data) {
        this.buffer = Buffer.concat([this.buffer, data]);

        let size = this.buffer.readUInt32LE();

        while (this.buffer.length > size) {
            const packet = Packet.fromBuffer(this.buffer);

            this.handlePacket(packet);
            this.buffer = this.buffer.slice(size);

            size = this.buffer.length > 4 ? this.buffer.readUInt32LE() : 0;
        }
    }

    handlePacket(packet) {
        Logger.debug(`[P: ${this.socket.localPort}] ${packet}`);

        if (packet.opname) {
            this.emit(packet.opname, new Message(this.socket, packet));
        }
    }

    async send(opname, data) {
        const packet = this.builder.build(opname, data);
        const message = new Message(this.socket, packet);

        await message.send();
    }
}

class Server {
    constructor(port, handlers) {
        this.handlers = handlers;
        this.client = null;
        this.server = net.createServer();
        this.server.listen({ port }, this.onListen.bind(this));
        this.server.on("connection", this.onConnection.bind(this));
    }

    onListen(e) {
        if (e) {
            throw e;
        }

        Logger.debug("listening ", this.server.address());
    }

    onConnection(socket) {
        Logger.debug(`[${socket.localPort}] connected ${socket.remoteAddress}`);

        if (this.client) {
            this.client.destroy();
        }

        this.client = new Client(socket);

        Object.entries(this.handlers).forEach(([opname, fn]) => {
            this.client.on(opname, fn);
        });
    }

    sendCommand(command, data = undefined) {
        return new Promise((resolve) =>{
            const [query, reply] = COMMANDS[command];

            this.client.once(reply, resolve);
            this.client.send(query, data);
        });
    }

    async sendMessage(opname, data = undefined) {
        await this.client.send(opname, data);
    }

    close() {
        if (this.client) {
            this.client.destroy();
        }

        this.server.close();
    }
}

const FAN_SPEEDS = {
    [FAN_SPEED_STATE_VALUE.OFF]: 0,
    [FAN_SPEED_STATE_VALUE.LOW]: 1,
    [FAN_SPEED_STATE_VALUE.MEDIUM]: 2,
    [FAN_SPEED_STATE_VALUE.HIGH]: 3,
};

const FAN_SPEEDS_REVERSED = flip(FAN_SPEEDS);

class DeviceStatus {
    constructor() {
        this.workMode = null;
        this.battery = 0;
        this.chargeStatus = false;
        this.cleanTime = 0;
        this.cleanSize = 0;
        this.type = 0;
        this.cleanPreference = 0;
    }

    update(data) {
        this.workMode = data.workMode;
        this.battery = data.battery;
        this.chargeStatus = data.chargeStatus;
        this.cleanTime = data.cleanTime;
        this.cleanSize = data.cleanSize;
        this.type = data.type;
        this.cleanPreference = data.cleanPreference;
    }

    getBatteryState() {
        let flag = BATTERY_FLAG.DISCHARGING;

        if (this.chargeStatus) {
            flag = this.battery === BATTERY_MAX ? BATTERY_FLAG.CHARGED : BATTERY_FLAG.CHARGING;
        }

        return new BatteryStateAttribute({
            level: this.battery * 100 / BATTERY_MAX,
            flag
        });
    }

    getStatusStateValue() {
        if (![0, 3].includes(this.type)) {
            return STATUS_STATE_VALUE.ERROR;
        }

        if (this.chargeStatus) {
            return STATUS_STATE_VALUE.DOCKED;
        }

        if ([5, 10].includes(this.workMode)) {
            return STATUS_STATE_VALUE.RETURNING;
        }

        if ([1, 7, 25, 20, 30].includes(this.workMode)) {
            return STATUS_STATE_VALUE.CLEANING;
        }

        if ([0, 4, 23, 29].includes(this.workMode)) {
            return STATUS_STATE_VALUE.IDLE;
        }

        return "unknown";
    }

    getStatusStateFlag() {
        if ([0, 1, 4, 5, 10, 11].includes(this.workMode)) {
            return STATUS_STATE_FLAG.NONE;
        }

        if ([7, 9, 14, 22, 36, 37, 38, 39, 40].includes(this.workMode)) {
            return STATUS_STATE_FLAG.SPOT;
        }

        return "unknown";
    }

    getStatusState() {
        const value = this.getStatusStateValue();
        const flag = this.getStatusStateFlag();

        return new StatusStateAttribute({
            value,
            flag
        });
    }

    getFanSpeedState() {
        return new FanSpeedStateAttribute({
            value: FAN_SPEEDS_REVERSED[this.cleanPreference]
        });
    }

    getLatestCleanupArea() {
        return new LatestCleanupStatisticsAttribute({
            type: LATEST_CLEANUP_STATISTICS_TYPE.AREA,
            value: this.cleanSize * 100
        });
    }

    getLatestCleanupDuration() {
        return new LatestCleanupStatisticsAttribute({
            type: LATEST_CLEANUP_STATISTICS_TYPE.DURATION,
            value: this.cleanTime * 60
        });
    }
}

class Map {
    constructor() {
        this.id = 0;
        this.floors = new MapLayer({
            type: MapLayer.TYPE.FLOOR,
            pixels: []
        });
        this.walls = new MapLayer({
            type: MapLayer.TYPE.WALL,
            pixels: []
        });
        this.charger = new PointMapEntity({
            type: PointMapEntity.TYPE.CHARGER_LOCATION,
            points: [0, 0]
        });
        this.robot = new PointMapEntity({
            type: PointMapEntity.TYPE.ROBOT_POSITION,
            points: [0, 0]
        });
        this.path = new PathMapEntity({
            type: PathMapEntity.TYPE.PATH,
            points: []
        });
        // Some defaults values for the unfetched map...
        this.size = { x: 800, y: 800 };
        this.min = { x: -20, y: -20 };
        this.max = { x: 20, y: 20 };
        this.valetudoMap = new ValetudoMap({
            pixelSize: 1, // ?
            entities: [
                this.charger,
                this.robot,
                this.path
            ],
            layers: [
                this.floors,
                this.walls
            ],
            metaData: {},
            size: this.size,
        });
    }

    getRelativePosition(pos) {
        return {
            x: Math.floor((pos.x - this.min.x) * this.size.x / (this.max.x - this.min.x)),
            y: this.size.y - Math.floor((pos.y - this.min.y) * this.size.y / (this.max.y - this.min.y))
        };
    }

    getAbsolutePosition(pos) {
        return {
            x: (pos.x / this.size.x) * (this.max.x - this.min.x) + this.min.x,
            y: this.size.y - (pos.y / this.size.y) * (this.max.y - this.min.y) + this.min.y
        };
    }

    update(data) {
        const { mapGrid, mapHeadInfo, robotChargeInfo, robotPoseInfo } = data;
        const floors = [];
        const walls = [];
        const size = { x: mapHeadInfo.sizeX, y: mapHeadInfo.sizeY };
        const min = { x: mapHeadInfo.minX, y: mapHeadInfo.minY };
        const max = { x: mapHeadInfo.maxX, y: mapHeadInfo.maxY };

        for (let x = 0; x < size.x; x++) {
            for (let y = 0; y < size.y; y++) {
                // invert map coords...
                const coor = (size.y - y) * size.y + x;
                const point = mapGrid[coor];

                if (point === 255) {
                    walls.push(x, y);
                } else if (point !== 0){
                    floors.push(x, y);
                }
            }
        }

        this.id = mapHeadInfo.mapHeadId;
        this.size = size;
        this.min = min;
        this.max = max;
        this.floors.pixels = floors;
        this.walls.pixels = walls;
        this.valetudoMap.size = size;

        if (robotChargeInfo) {
            this.updateChargerPosition(robotChargeInfo);
        }

        if (robotPoseInfo) {
            this.updateRobotPosition(robotPoseInfo);
        }
    }

    updateChargerPosition(chargerInfo) {
        const charger = this.getRelativePosition({ x: chargerInfo.poseX, y: chargerInfo.poseY });

        // hardcoded pixel size
        // must be fixed in mmToCanvasPx function
        this.charger.points = [charger.x * 5, charger.y * 5];
    }

    updateRobotPosition(robotInfo) {
        const charger = this.getRelativePosition({ x: robotInfo.poseX, y: robotInfo.poseY });

        // hardcoded pixel size
        // must be fixed in mmToCanvasPx function
        this.robot.points = [charger.x * 5, charger.y * 5];
    }
}

function randomNumber(low, high) {
    return Math.floor(Math.random() * (high - low + 1) + low);
}

const DEVICE_ID = randomNumber(1, 1e8);
const USER_ID = randomNumber(1, 1e6);

class CecotecConga3490 {
    constructor(options) {
        this.device = null;
        this.deviceStatus = new DeviceStatus();
        this.events = options.events;
        this.map = new Map();
        this.robotState = new RobotState({
            map: this.map.valetudoMap
        });
        this.handlers = {
            QMSG_PING: this.handlePing.bind(this),
            QMSG_DEVICE_LOGIN: this.handleDeviceLogin.bind(this),
            QMSG_DEVICE_SIGNUP: this.handleDeviceSignup.bind(this),
            QMSG_DEVICE_INFO: this.handleDeviceInfo.bind(this),
            QMSG_DEVICE_VERSION: this.handleDeviceVersion.bind(this),
            QMSG_DEVICE_OTA: this.handleDeviceOta.bind(this),
            QMSG_BATTERY_LEVEL: this.handleBatteryLevel.bind(this),
            QMSG_DEVICE_STATUS: this.handleDeviceStatus.bind(this),
            RMSG_MAP_INFO: this.handleMapUpdate.bind(this),
            RMSG_MAP_UPDATE: this.handleMapUpdate.bind(this),
            RMSG_UPDATE_ROBOT_POSITION: this.handleUpdateRobotPosition.bind(this),
            RMSG_UPDATE_CHARGE_POSITION: this.handleUpdateChargePosition.bind(this),
            RMSG_UNK1: this.handleUnk1.bind(this),
        };
        this.cmdServer = new Server(4010, this.handlers);
        this.mapServer = new Server(4030, this.handlers);
    }

    shutdown() {
        this.cmdServer.close();
        this.mapServer.close();
    }

    async findRobot() {
        await this.cmdServer.sendCommand("LOCATE_DEVICE");
    }

    async getCurrentStatus() {
        return this.robotState;
    }

    async getFanSpeeds() {
        return FAN_SPEEDS;
    }

    async setFanSpeed(speed) {
        const mode = FAN_SPEEDS[speed];

        await this.cmdServer.sendCommand("SET_FAN_MODE", { mode });
    }

    async driveHome() {
        await this.cmdServer.sendCommand("RETURN_HOME", {
            unk1: 1
        });
    }

    async startCleaning() {
        await this.cmdServer.sendCommand("CLEAN_MODE", {
            mode: 1,
            unk1: 2
        });
    }

    async stopCleaning() {
        await this.cmdServer.sendCommand("CLEAN_MODE", {
            mode: 2,
            unk1: 2
        });
    }

    async pauseCleaning() {
        await this.cmdServer.sendCommand("CLEAN_MODE", {
            mode: 2,
            unk1: 2
        });
    }

    async goTo(x, y) {
        const size = this.map.size;
        // hardcoded pixel size
        // remember to invert map coords...
        const pose = this.map.getAbsolutePosition({ x: x / 5, y: y / 5 });

        await this.cmdServer.sendCommand("SET_POSITION", {
            mapHeadId: this.map.id,
            poseX: pose.x,
            poseY: pose.y,
            posePhi: 0.0,
            update: 1
        });
    }

    async startCleaningZoneByCoords(zones) {
        const size = this.map.size;
        const data = {
            mapHeadId: this.map.id,
            unk1: 0,
            cleanAreaLength: zones.length
        };

        data.cleanAreaList = zones.map(([x1, y1, x2, y2]) => {
            const a = this.map.getAbsolutePosition({ x: x1 / 5, y: y1 / 5 });
            const c = this.map.getAbsolutePosition({ x: x2 / 5, y: y2 / 5 });
            const b = { x: a.x, y: c.y };
            const d = { x: c.x, y: a.y };

            return {
                cleanAreaId: randomNumber(1, 1e6),
                unk1: 0,
                coordinateLength: 4,
                coordinateList: [a, b, c, d]
            };
        });

        await this.cmdServer.sendCommand("SET_AREA", data);
        await this.cmdServer.sendCommand("CLEAN_AREA", { unk1: 1 });
    }

    async handlePing(message) {
        await message.buildResponse("RMSG_PING").send();
        await this.cmdServer.sendCommand("DEVICE_CHECK");
    }

    async handleDeviceInfo(message) {
        await message.buildResponse("RMSG_DEVICE_INFO", { result: 0 }).send();
    }

    async handleDeviceVersion(message) {
        await message.buildResponse("RMSG_DEVICE_VERSION", { result: 0 }).send();
    }

    async handleDeviceOta(message) {
        await message.buildResponse("RMSG_DEVICE_OTA", { result: 0 }).send();
    }

    async handleDeviceLogin(message) {
        const deviceSerialNumber = message.packet.data.deviceSerialNumber;

        if (!this.device || this.device.id !== message.packet.deviceId) {
            await message.buildResponse("RMSG_DEVICE_LOGIN", {
                result: 12002,
                reason: `Device not registered(devsn: ${deviceSerialNumber})`
            }).send();
        } else {
            this.cmdServer.client.builder.setUserId(USER_ID/*message.packet.userId*/);
            this.cmdServer.client.builder.setDeviceId(message.packet.deviceId);

            await message.buildResponse("RMSG_DEVICE_LOGIN", { result: 0 }).send();

            // Handshake
            await this.cmdServer.sendCommand("DEVICE_CHECK");
            await this.cmdServer.sendMessage("QMSG_CONNECT_DEVICE");
            await this.cmdServer.sendCommand("UNK2", { unk1: 0, unk2: "" });
            await this.cmdServer.sendCommand("DEVICE_TIME");
            // TODO: query map info on 4030 connection
            await new Promise(resolve => setTimeout(resolve, 1000));
            await this.cmdServer.sendCommand("MAP_INFO", { mask: 0x78FF });
        }
    }

    async handleDeviceSignup(message) {
        let id;

        if (this.device && this.device.deviceSerialNumber === message.packet.data.deviceSerialNumber) {
            id = this.device.id;
        } else {
            id = DEVICE_ID;

            this.device = new Device({
                ...message.packet.data,
                id
            });
        }

        await message.buildResponse("RMSG_DEVICE_SIGNUP", { result: 0, device: { id } }).send();
    }

    async handleBatteryLevel(message) {
        const { data } = message.packet;

        this.deviceStatus.update({
            battery: data.battery.level
        });

        this.robotState.upsertFirstMatchingAttribute(this.deviceStatus.getBatteryState());

        this.events.emitStatusUpdated(this.robotState);

        await message.buildResponse("RMSG_BATTERY_LEVEL", { result: 0 }).send();
    }

    async handleDeviceStatus(message) {
        const { data } = message.packet;

        this.cmdServer.client.builder.setUserId(message.packet.userId);
        this.cmdServer.client.builder.setDeviceId(message.packet.deviceId);

        this.deviceStatus.update(data);
        this.robotState.upsertFirstMatchingAttribute(this.deviceStatus.getBatteryState());
        this.robotState.upsertFirstMatchingAttribute(this.deviceStatus.getStatusState());
        this.robotState.upsertFirstMatchingAttribute(this.deviceStatus.getFanSpeedState());
        this.robotState.upsertFirstMatchingAttribute(this.deviceStatus.getLatestCleanupArea());
        this.robotState.upsertFirstMatchingAttribute(this.deviceStatus.getLatestCleanupDuration());

        this.events.emitStatusUpdated(this.robotState);
    }

    async handleMapUpdate(message) {
        const { data } = message.packet;

        this.map.update(data);
        this.events.emitMapUpdated();
    }

    async handleUpdateRobotPosition(message) {
        const { data } = message.packet;

        this.map.updateRobotPosition(data);
        this.events.emitMapUpdated();
    }

    async handleUpdateChargePosition(message) {
        const { data } = message.packet;

        this.map.updateChargerPosition(data);
        this.events.emitMapUpdated();
    }

    async handleUnk1(message) {
        await message.buildResponse("RMSG_UNK1", { result: 0 }).send();
    }
}

module.exports = CecotecConga3490;