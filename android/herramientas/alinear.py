#!/usr/bin/env python3
"""Alinea un APK como zipalign -P 16: datos sin comprimir a 4 bytes y librerías .so a 16 KB
(necesario con extractNativeLibs=false y para teléfonos con páginas de 16 KB). Uso: alinear.py entrada salida"""
import struct, sys, zipfile

def main(src, dst):
    zin = zipfile.ZipFile(src)
    with open(dst, "wb") as out:
        zout = zipfile.ZipFile(out, "w")
        for info in zin.infolist():
            data = zin.read(info.filename)
            zi = zipfile.ZipInfo(info.filename, date_time=info.date_time)
            zi.compress_type = info.compress_type
            zi.external_attr = info.external_attr
            zi.create_system = info.create_system
            extra = b""
            if info.compress_type == zipfile.ZIP_STORED:
                align = 16384 if info.filename.endswith(".so") else 4
                pos = out.tell()
                name_len = len(info.filename.encode("utf-8"))
                base = pos + 30 + name_len
                pad = (-(base + 6)) % align       # campo extra 0xD935 (como zipalign): id + tamaño + alineación + relleno
                extra = struct.pack("<HHH", 0xD935, 2 + pad, align) + b"\0" * pad
            zi.extra = extra
            zout.writestr(zi, data, compress_type=info.compress_type)
        zout.close()

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
