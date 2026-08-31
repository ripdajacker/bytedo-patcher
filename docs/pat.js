// Port of xusb_id_patcher.py to the browser.
//
// Parses an 8BitDo controller firmware update file, locates the 4-byte XUSB ID
// in the payload, optionally patches it to a new value, and recomputes the
// embedded CRC32 (by solving a linear system over GF(2)) so the file validates.

const STOCK_ID = [0x52, 0x18, 0x06, 0x84]; // 2DC8 Ultimate 2C stock XUSB ID

// ---- CRC32 (ISO-HDLC / IEEE, reflected, poly 0xEDB88320, init 0xFFFFFFFF) ----
// Matches zlib.crc32 (no final XOR).
const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c;
    }
    return table;
})();

function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0; // final XOR; matches zlib.crc32
}

// ---- Firmware update parsing (see 8bitdo-firmwareupdate.hexpat) ----
// Header: u8 version, 3 pad, u32 flash_dst, u32 payload_size, u16 product_id,
// 2 pad, u32 unknown1, 8 pad  (28 bytes total), followed by the payload.
function parseFirmwareUpdate(data) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const headerVersion = data[0];
    const payloadSize = dv.getUint32(8, true);
    const productId = dv.getUint16(12, true);
    const payload = new Uint8Array(data.slice(28, 28 + payloadSize));
    return { headerVersion, payloadSize, productId, payload };
}

// ---- Locate the 4-byte ID in the payload ----
function locateXid(payload, expectedId) {
    const hits = [];
    let pos = 0;
    while (pos <= payload.length - 4) {
        let match = true;
        for (let i = 0; i < 4; i++) {
            if (payload[pos + i] !== expectedId[i]) {
                match = false;
                break;
            }
        }
        if (match) hits.push(pos);
        pos++;
    }
    if (hits.length === 0) {
        throw new Error(`Could not find XUSB ID ${hex(expectedId)} in firmware update.`);
    }
    if (hits.length > 1) {
        throw new Error(`Found more than one XUSB ID ${hex(expectedId)} in firmware update.`);
    }
    return hits[0];
}

function locateStuffing(payload) {
    for (let i = payload.length - 1; i >= 0; i--) {
        if (payload[i] !== 0) return i - 3;
    }
    return -1;
}

// ---- Recompute the CRC by patching the stuffing bytes ----
// CRC32 is linear over GF(2): flipping patch bit i changes the final CRC by a
// fixed amount. Solve a 32x32 linear system by Gaussian elimination.
function solveCrc32(payload) {
    const pos = locateStuffing(payload);
    if (pos < 0) throw new Error("Could not find stuffing in firmware update.");

    payload.set([0, 0, 0, 0], pos);
    const c0 = crc32(payload);
    const cols = [];
    for (let i = 0; i < 32; i++) {
        payload[pos + (i >> 3)] = 1 << (i % 8);
        cols.push(crc32(payload) ^ c0);
        payload[pos + (i >> 3)] = 0;
    }

    const rhs = c0 ^ 0xffffffff;
    const rows = [];
    for (let e = 0; e < 32; e++) {
        let mask = 0;
        for (let i = 0; i < 32; i++) {
            if ((cols[i] >> e) & 1) mask |= 1 << i;
        }
        rows.push([mask, (rhs >> e) & 1]);
    }

    for (let col = 0; col < 32; col++) {
        let pivot = -1;
        for (let r = col; r < 32; r++) {
            if ((rows[r][0] >> col) & 1) {
                pivot = r;
                break;
            }
        }
        const tmp = rows[col];
        rows[col] = rows[pivot];
        rows[pivot] = tmp;
        for (let r = 0; r < 32; r++) {
            if (r !== col && (rows[r][0] >> col) & 1) {
                rows[r][0] ^= rows[col][0];
                rows[r][1] ^= rows[col][1];
            }
        }
    }

    let x = 0;
    for (let col = 0; col < 32; col++) {
        if (rows[col][1]) x |= 1 << col;
    }

    payload.set([x & 0xff, (x >> 8) & 0xff, (x >> 16) & 0xff, (x >>> 24) & 0xff], pos);
    return pos;
}

// ---- Helpers ----
function hex(bytes) {
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseHex(s) {
    const clean = s.replace(/^0x/i, "").replace(/\s+/g, "");
    if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length !== 8) {
        throw new Error(`"${s}" is not an 8-hex-digit XID.`);
    }
    const bytes = [];
    for (let i = 0; i < 4; i++) {
        bytes.push(parseInt(clean.substr(i * 2, 2), 16));
    }
    return bytes;
}

// ---- UI wiring ----
const output = document.getElementById("output");
const deviceOutput = document.getElementById("device-output");
let current = null; // { data, update, name }

function log(msg, cls) {
    output.textContent = msg;
    output.className = cls || "";
}

function logDevice(msg, cls) {
    deviceOutput.textContent = msg;
    deviceOutput.className = cls || "";
}

document.getElementById("read-device").addEventListener("click", async () => {
    logDevice("Connecting...");
    try {
        const info = await connectAndRead();
        const derived = deriveXidFromSerial(info.serial);
        const newxidEl = document.getElementById("newxid");
        newxidEl.value = derived;
        logDevice(
            describeDevice(info) +
                `\n\nTarget XID (first 4 bytes of serial): ${derived}\n` +
                `Filled into "New XID".`
        );
    } catch (err) {
        console.error(err);
        if (err.name === "NotFoundError") {
            logDevice("No device was selected.");
        } else if (err.name === "SecurityError" || /Access denied/i.test(err.message)) {
            logDevice(connectAccessDeniedMessage(err));
        } else {
            logDevice(`Error: ${err.message}`);
        }
    }
});

function describe(update, expectedId, label) {
    return (
        `${label}\n` +
        `    Version: ${update.headerVersion}\n` +
        `    PID: 0x${update.productId.toString(16)}\n` +
        `    CRC: 0x${crc32(update.payload).toString(16)}\n` +
        `    XID (${hex(expectedId)}) at offset: 0x${locateXid(update.payload, expectedId).toString(16)}\n` +
        `    Stuffing: 0x${locateStuffing(update.payload).toString(16)}`
    );
}

document.getElementById("show-details").addEventListener("click", async () => {
    try {
        const fileInput = document.getElementById("file");
        if (!fileInput.files.length) throw new Error("Choose a .dat file first.");
        const file = fileInput.files[0];
        const buf = await file.arrayBuffer();
        const data = new Uint8Array(buf);
        const update = parseFirmwareUpdate(data);
        const expected = parseHex(document.getElementById("expected").value || "52180684");
        current = { data, update, name: file.name };
        log(describe(update, expected, file.name), "ok");
    } catch (err) {
        log(`Error: ${err.message}`, "error");
    }
});

document.getElementById("patch").addEventListener("click", () => {
    try {
        if (!current || !current.data) throw new Error("Load a .dat file first (click Show).");
        const newXid = parseHex(document.getElementById("newxid").value);
        const expected = parseHex(document.getElementById("expected").value || "52180684");
        const { data, update, name } = current;

        const pos = locateXid(update.payload, expected);
        const oldXid = [...update.payload.slice(pos, pos + 4)];

        update.payload.set(newXid, pos);
        solveCrc32(update.payload);

        const out = new Uint8Array(data.length);
        out.set(data.slice(0, 28), 0); // preserve 28-byte header
        out.set(update.payload, 28);

        log(
            `Patching XID from ${hex(oldXid)} to ${hex(newXid)}\n` +
                `    CRC: 0x${crc32(out.slice(28)).toString(16)}\n\nDownloading patched file.`,
            "ok"
        );

        const blob = new Blob([out], { type: "application/octet-stream" });
        const base = (name || "firmware").replace(/\.dat$/i, "");
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${base}-patched.dat`;
        a.click();
        URL.revokeObjectURL(a.href);
    } catch (err) {
        log(`Error: ${err.message}`, "error");
    }
});
