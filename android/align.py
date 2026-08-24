"""Writes the final APK zip.

Two constraints the standard library will not handle on its own: an
uncompressed resources.arsc has to begin on a four-byte boundary or the
installer rejects the package on API 30 and above, and classes.dex has to be
added without disturbing the offsets aapt2 already laid out.
"""
import struct, sys, zipfile, zlib

base, dex, dst = sys.argv[1], sys.argv[2], sys.argv[3]
ALIGN = 4

zin = zipfile.ZipFile(base)
entries = [(i.filename, i.compress_type, zin.read(i.filename)) for i in zin.infolist()]
zin.close()
entries.append(("classes.dex", zipfile.ZIP_DEFLATED, open(dex, "rb").read()))

out = open(dst, "wb")
records = []
for name, ctype, data in entries:
    store = name == "resources.arsc" or name.endswith(".png") or ctype == zipfile.ZIP_STORED
    if store:
        blob, method = data, 0
    else:
        co = zlib.compressobj(9, zlib.DEFLATED, -15)
        blob, method = co.compress(data) + co.flush(), 8

    nb = name.encode()
    extra = b""
    if store:
        pos = out.tell() + 30 + len(nb)
        extra = b"\0" * ((ALIGN - (pos % ALIGN)) % ALIGN)

    offset = out.tell()
    out.write(struct.pack("<IHHHHHIIIHH", 0x04034B50, 20, 0, method, 0, 0,
                          zipfile.crc32(data) & 0xFFFFFFFF, len(blob), len(data),
                          len(nb), len(extra)))
    out.write(nb + extra + blob)
    records.append((nb, method, zipfile.crc32(data) & 0xFFFFFFFF, len(blob), len(data), len(extra), offset))

cd = out.tell()
for nb, method, crc, csize, usize, elen, offset in records:
    out.write(struct.pack("<IHHHHHHIIIHHHHHII", 0x02014B50, 20, 20, 0, method, 0, 0,
                          crc, csize, usize, len(nb), elen, 0, 0, 0, 0, offset))
    out.write(nb + b"\0" * elen)
out.write(struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, len(records), len(records),
                      out.tell() - cd, cd, 0))
out.close()
print("  aligned ->", dst)
