import hashlib
A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
def b58d(s):
    n=0
    for c in s: n=n*58+A.index(c)
    b=n.to_bytes(32,'big'); return b
def b58e(b):
    n=int.from_bytes(b,'big'); s=''
    while n: n,r=divmod(n,58); s=A[r]+s
    return '1'*(len(b)-len(b.lstrip(b'\0')))+s
p=2**255-19; d=(-121665*pow(121666,p-2,p))%p
def oc(b):
    y=int.from_bytes(b,'little')&((1<<255)-1)
    if y>=p: return False
    u=(y*y-1)%p; v=(d*y*y+1)%p; x2=u*pow(v,p-2,p)%p
    return x2==0 or pow(x2,(p-1)//2,p)==1
def pda(seeds,prog):
    prog=b58d(prog)
    for bump in range(255,-1,-1):
        h=hashlib.sha256(b"".join(seeds)+bytes([bump])+prog+b"ProgramDerivedAddress").digest()
        if not oc(h): return b58e(h)
