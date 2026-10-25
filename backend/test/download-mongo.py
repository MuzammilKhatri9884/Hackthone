"""Download only mongod.exe from the official ZIP using HTTP ranges for local QA."""
import urllib.request, struct, zlib, pathlib, sys
url='https://fastdl.mongodb.org/windows/mongodb-windows-x86_64-7.0.14.zip'
client=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def fetch(r):
    response=client.open(urllib.request.Request(url,headers={'Range':r}),timeout=45)
    if response.status != 206: raise RuntimeError('Server does not support range downloads')
    return response.read()
tail=fetch('bytes=-131072')
eocd=struct.unpack('<4s4H2LH',tail[tail.rfind(b'PK\x05\x06'):][:22])
central=fetch(f'bytes={eocd[6]}-{eocd[6]+eocd[5]-1}')
offset=0
while offset<len(central):
    h=struct.unpack('<4s6H3L5H2L',central[offset:offset+46])
    name=central[offset+46:offset+46+h[10]].decode()
    if name.endswith('/bin/mongod.exe'):
        compressed,expected,local=h[8],h[9],h[16]
        header=fetch(f'bytes={local}-{local+29}')
        local_h=struct.unpack('<4s5H3L2H',header)
        start=local+30+local_h[9]+local_h[10]
        print(f'Downloading mongod.exe only: {compressed//1048576} MB compressed',flush=True)
        result=fetch(f'bytes={start}-{start+compressed-1}')
        raw=zlib.decompress(result,-15)
        if len(raw)!=expected or zlib.crc32(raw)!=h[7]: raise RuntimeError('ZIP checksum mismatch')
        target=pathlib.Path(__file__).resolve().parent.parent/'node_modules/.cache/mongod-7.0.14.exe'
        target.write_bytes(raw)
        print(str(target),flush=True)
        break
    offset+=46+h[10]+h[11]+h[12]
else: raise RuntimeError('mongod.exe not found')
