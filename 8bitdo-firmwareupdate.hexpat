import type.base;

struct ControllerFirmwareUpdate {
    u8 version;
    padding[3];
    le u32 flash_dst;
    le u32 payload_size;
    type::Hex<u16> product_id;
    padding[2];
    type::Hex<u32> unknown1;
    padding[8];
    u8 payload[payload_size];
};

ControllerFirmwareUpdate update @ 0x00;