const VENDOR_ID = 0x2dc8; // 8BitDo
const REQUEST = 0x01; // Get_Device_ID (bRequest)
const LENGTH = 4;

const output = document.getElementById("output");
const connectBtn = document.getElementById("connect");

function log(msg) {
    output.textContent = msg;
}

function bytesToHex(bytes) {
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function deviceInfo(device) {
    const lines = [`vendor  = 0x${device.vendorId.toString(16)}`];
    if (device.productId) {
        lines.push(`product = 0x${device.productId.toString(16)}`);
    }
    if (device.serialNumber) {
        lines.push(`serial  = ${device.serialNumber}`);
    }
    lines.push(`name    = ${device.productName || "?"}`);
    if (device.usbVersionMajor !== undefined) {
        lines.push(
            `usb     = ${device.usbVersionMajor}.${device.usbVersionMinor}.${device.usbVersionSubminor}`
        );
    }
    return lines.join("\n");
}

async function getXusbId(device) {
    // struct usbdevfs_ctrltransfer equivalent: bmRequestType=0xC0, bRequest=0x01,
    // wValue=0x0000, wIndex=0x0000, wLength=4.
    const result = await device.controlTransferIn(
        {
            requestType: "vendor",
            recipient: "device",
            request: REQUEST,
            value: 0x0000,
            index: 0x0000,
        },
        LENGTH
    );

    if (result.status !== "ok") {
        throw new Error(`Control transfer failed: ${result.status}`);
    }
    return new Uint8Array(result.data.buffer, result.data.byteOffset, LENGTH);
}

connectBtn.addEventListener("click", async () => {
    output.textContent = "Connecting...";
    try {
        if (!navigator.usb) {
            throw new Error(
                "WebUSB is not supported here. Use a Chromium-based browser over HTTPS or localhost."
            );
        }

        const device = await navigator.usb.requestDevice({
            filters: [{ vendorId: VENDOR_ID }],
        });

        await device.open();

        // Claim the device's interfaces. The 8BitDo controller's interfaces may
        // be bound to a kernel driver (e.g. hid-generic); claiming the control
        // interface grants us access to its control pipe.
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
            const xid = await getXusbId(device);
            log(
                deviceInfo(device) +
                    `\n\nxid = ${bytesToHex(xid)}\n\nQuery OK. You can disconnect the device.`
            );
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
    } catch (err) {
        console.error(err);
        if (err.name === "NotFoundError") {
            log("No device was selected.");
        } else if (err.name === "SecurityError" || /Access denied/i.test(err.message)) {
            log(
                `Error: ${err.message}\n\n` +
                    "Access to the device was denied. Common causes:\n" +
                    "  - A kernel driver is bound to the device. Grant the user who owns\n" +
                    "    /dev/bus/usb/... write access, or set up a udev rule so the WebUSB\n" +
                    "    session can detach the existing driver.\n" +
                    "  - The device may be held open by another application (e.g. the\n" +
                    "    8BitDo software or xusb_id.py). Close other tools that have it open.\n" +
                    "  - Check that this page is served from an HTTPS or localhost origin."
            );
        } else {
            log(`Error: ${err.message}`);
        }
    }
});
