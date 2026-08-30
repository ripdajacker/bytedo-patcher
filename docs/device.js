// Shared WebUSB helpers for reading controller info.
//
// Mirrors xusb_id.py, which sends a 2.2.8.5 Get_Device_ID control transfer
// (bmRequestType=0xC0: vendor, IN, device; bRequest=0x01; len=4).
//
// Note: WebUSB requires a secure context (HTTPS or localhost) and is only
// supported in Chromium-based browsers.

const USB_VENDOR_ID = 0x2dc8; // 8BitDo
const USB_REQUEST = 0x01; // Get_Device_ID (bRequest)
const USB_LENGTH = 4;

function bytesToHex(bytes) {
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function deriveXidFromSerial(serial) {
    // The XUSB ID is the first 4 bytes (8 hex chars) of the controller serial.
    const clean = (serial || "").replace(/[\s-]/g, "");
    const head = clean.slice(0, 8);
    if (!/^[0-9a-fA-F]{8}$/.test(head)) {
        throw new Error(
            `Could not derive an XID from serial "${serial}": expected 8 hex digits at the start.`
        );
    }
    return head.toLowerCase();
}

async function readDevice(device) {
    // struct usbdevfs_ctrltransfer equivalent: bmRequestType=0xC0, bRequest=0x01,
    // wValue=0x0000, wIndex=0x0000, wLength=4.
    const result = await device.controlTransferIn(
        {
            requestType: "vendor",
            recipient: "device",
            request: USB_REQUEST,
            value: 0x0000,
            index: 0x0000,
        },
        USB_LENGTH
    );

    if (result.status !== "ok") {
        throw new Error(`Control transfer failed: ${result.status}`);
    }
    return new Uint8Array(result.data.buffer, result.data.byteOffset, USB_LENGTH);
}

async function connectAndRead() {
    if (!navigator.usb) {
        throw new Error(
            "WebUSB is not supported here. Use a Chromium-based browser over HTTPS or localhost."
        );
    }

    const device = await navigator.usb.requestDevice({
        filters: [{ vendorId: USB_VENDOR_ID }],
    });

    await device.open();

    // Claim the device's interfaces. The controller's interfaces may be bound to
    // a kernel driver (e.g. hid-generic); claiming the control interface grants
    // access to its control pipe.
    const claimed = [];
    try {
        for (const configuration of device.configurations) {
            for (const iface of configuration.interfaces) {
                try {
                    await device.claimInterface(iface.interfaceNumber);
                    claimed.push(iface.interfaceNumber);
                } catch (e) {
                    console.warn(
                        `Could not claim interface ${iface.interfaceNumber}: ${e.message}`
                    );
                }
            }
        }
    } catch (e) {
        console.warn(`Error enumerating configuration: ${e.message}`);
    }

    try {
        const xid = await readDevice(device);
        return {
            serial: device.serialNumber || "?",
            xid: bytesToHex(xid),
            vendorId: device.vendorId,
            productId: device.productId,
            productName: device.productName,
            currentXid: bytesToHex(xid),
        };
    } finally {
        for (const n of claimed) {
            try {
                await device.releaseInterface(n);
            } catch (e) {
                /* ignore */
            }
        }
        await device.close();
    }
}

function connectAccessDeniedMessage(err) {
    return (
        `Error: ${err.message}\n\n` +
        "Access to the device was denied. Common causes:\n" +
        "  - A kernel driver is bound to the device. Grant the user who owns\n" +
        "    /dev/bus/usb/... write access, or set up a udev rule so the WebUSB\n" +
        "    session can detach the existing driver.\n" +
        "  - The device may be held open by another application (e.g. the\n" +
        "    8BitDo software or xusb_id.py). Close other tools that have it open.\n" +
        "  - Check that this page is served from an HTTPS or localhost origin."
    );
}

function describeDevice(info) {
    return (
        `vendor  = 0x${info.vendorId.toString(16)}\n` +
        (info.productId ? `product = 0x${info.productId.toString(16)}\n` : "") +
        `serial  = ${info.serial}\n` +
        `name    = ${info.productName || "?"}\n` +
        `xid     = ${info.xid}`
    );
}
