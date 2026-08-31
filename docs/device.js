// Shared WebUSB helpers for reading controller info.
//
// Mirrors xusb_id.py, which sends a 2.2.8.5 Get_Device_ID control transfer
// (bmRequestType=0xC0: vendor, IN, device; bRequest=0x01; len=4).
//
// Note: WebUSB requires a secure context (HTTPS or localhost) and is only
// supported in Chromium-based browsers.

const USB_REQUEST = 0x01; // Get_Device_ID (bRequest)
const USB_LENGTH = 4;

// Xbox 360-style controller matching, mirrored from the Linux kernel's xpad
// driver (drivers/input/joystick/xpad.c). xpad matches an Xbox 360 controller
// by vendor ID plus interface info: class 0xFF (vendor specific), subclass 93,
// protocol 1 (wired) or 129 (wireless). XPAD_XBOX360_VENDOR() expands to both
// protocol variants, reproduced here as WebUSB filters (vendorId, classCode,
// subclassCode, protocolCode match the device or any of its interfaces).
const X360_CLASS = 0xff; // USB_CLASS_VENDOR_SPEC
const X360_SUBCLASS = 93;
const X360_PROTOCOLS = [1, 129]; // wired, wireless

// XPAD_XBOX360_VENDOR() entries from xpad_table, sorted by vendor ID.
const X360_VENDOR_IDS = [
  0x0079, // GPD Win 2 controller
  0x0351, // CRKD Controllers
  0x03eb, // Wooting Keyboards (Legacy)
  0x03f0, // HP HyperX Xbox 360 controllers
  0x044f, // Thrustmaster Xbox 360 controllers
  0x045e, // Microsoft Xbox 360 controllers
  0x046d, // Logitech Xbox 360-style controllers
  0x0502, // Acer Inc. Xbox 360 style controllers
  0x056e, // Elecom JC-U3613M
  0x06a3, // Saitek P3600
  0x0738, // Mad Catz Xbox 360 controllers
  0x07ff, // Mad Catz Gamepad
  0x0b05, // ASUS controllers
  0x0c12, // Zeroplus X-Box 360 controllers
  0x0db0, // Micro Star International X-Box 360 controllers
  0x0e6f, // 0x0e6f Xbox 360 controllers
  0x0f0d, // Hori controllers
  0x1038, // SteelSeries controllers
  0x11c9, // Nacon GC100XF
  0x11ff, // PXN V900
  0x1209, // Ardwiino Controllers
  0x12ab, // Xbox 360 dance pads
  0x1430, // RedOctane Xbox 360 controllers
  0x146b, // Bigben Interactive controllers
  0x1532, // Razer Sabertooth
  0x15e4, // Numark Xbox 360 controllers
  0x162e, // Joytech Xbox 360 controllers
  0x1689, // Razer Onza
  0x17ef, // Lenovo
  0x1949, // Amazon controllers
  0x1a86, // Nanjing Qinheng Microelectronics (WCH)
  0x1bad, // Harmonix Rock Band guitar and drums
  0x1ee9, // ZOTAC Technology Limited
  0x20bc, // BETOP wireless dongles
  0x20d6, // PowerA controllers
  0x2345, // Machenike Controllers
  0x24c6, // PowerA controllers
  0x2563, // OneXPlayer Gamepad
  0x260d, // Dareu H101
  0x2993, // TECNO Mobile
  0x2c22, // Qanba Controllers
  0x2dc8, // 8BitDo Controllers
  0x2f24, // GameSir Controllers
  0x31e3, // Wooting Keyboards
  0x3285, // Nacon GC-100
  0x3507, // ZENAIM Controllers
  0x3537, // GameSir Controllers
  0x3651, // CRKD Controllers
  0x37d7, // Flydigi Controllers
  0x3958, // RedOctane Games Controllers
  0x413d, // Black Shark Green Ghost Controller
];

function buildRequestFilters() {
  const filters = [];
  for (const vendorId of X360_VENDOR_IDS) {
    for (const protocolCode of X360_PROTOCOLS) {
      filters.push({
        vendorId,
        classCode: X360_CLASS,
        subclassCode: X360_SUBCLASS,
        protocolCode,
      });
    }
  }
  // { USB_DEVICE(0x0738, 0x4540) } /* Mad Catz Beat Pad */
  filters.push({ vendorId: 0x0738, productId: 0x4540 });
  return filters;
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function deriveXidFromSerial(serial) {
  // The XUSB ID is the first 4 bytes (8 hex chars) of the controller serial.
  const clean = (serial || "").replace(/[\s-]/g, "");
  const head = clean.slice(0, Math.min(clean.length, 8));
  if (head.length < 8) {
    for (let i = 0; i < 8 - head.length; i++) {
      head = head + "F";
    }
  }

  if (!/^[0-9a-fA-F]{8}$/.test(head)) {
    throw new Error(
      `Could not derive an XID from serial "${serial}": expected 8 hex digits at the start.`,
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
    USB_LENGTH,
  );

  if (result.status !== "ok") {
    throw new Error(`Control transfer failed: ${result.status}`);
  }
  return new Uint8Array(result.data.buffer, result.data.byteOffset, USB_LENGTH);
}

async function connectAndRead() {
  if (!navigator.usb) {
    throw new Error(
      "WebUSB is not supported here. Use a Chromium-based browser over HTTPS or localhost.",
    );
  }

  const device = await navigator.usb.requestDevice({
    filters: buildRequestFilters(),
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
          console.warn(`Could not claim interface ${iface.interfaceNumber}: ${e.message}`);
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
