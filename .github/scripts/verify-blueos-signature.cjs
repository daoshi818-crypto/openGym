// BlueOS signed ZIP verification, shared by the release checks.
const zlib=require('node:zlib'), crypto=require('node:crypto'), assert=require('node:assert/strict');
const sha=b=>crypto.createHash('sha256').update(b).digest();
function layout(b){let e=b.length-22;while(e>=0&&b.readUInt32LE(e)!==0x06054b50)e--;assert(e>=0,'EOCD');return {e,c:b.readUInt32LE(e+16)};}
function unzip(b){const {e,c}=layout(b);let p=c;const files={};while(p<e){assert.equal(b.readUInt32LE(p),0x02014b50);const method=b.readUInt16LE(p+10),len=b.readUInt32LE(p+20),nl=b.readUInt16LE(p+28),el=b.readUInt16LE(p+30),cl=b.readUInt16LE(p+32),off=b.readUInt32LE(p+42),name=b.toString('utf8',p+46,p+46+nl);assert.equal(b.readUInt32LE(off),0x04034b50);const start=off+30+b.readUInt16LE(off+26)+b.readUInt16LE(off+28),data=b.subarray(start,start+len);files[name]=method===8?zlib.inflateRawSync(data):(assert.equal(method,0),data);p+=46+nl+el+cl;}return files;}
function verify(b, fingerprint){const {e,c}=layout(b),magic=Buffer.from('RPK Sig Block 42');assert(b.subarray(c-16,c).equals(magic),'magic');const size=Number(b.readBigUInt64LE(c-24)),start=c-size-8;assert.equal(Number(b.readBigUInt64LE(start)),size);let p=start+8,main;
while(p<c-24){const n=Number(b.readBigUInt64LE(p)),id=b.readUInt32LE(p+8);if(id===16777473)main=b.subarray(p+12,p+8+n);p+=8+n;}assert(main,'main signer');
let q=0;function take(buf,offset){const n=buf.readUInt32LE(offset);return [buf.subarray(offset+4,offset+4+n),offset+4+n];}
let list;[list,q]=take(main,0);assert.equal(q,main.length);let signer;[signer,q]=take(list,0);assert.equal(q,list.length);
let data,sigs,pub;[data,q]=take(signer,0);[sigs,q]=take(signer,q);[pub,q]=take(signer,q);assert.equal(q,signer.length);
let digests,certs;[digests,q]=take(data,0);[certs,q]=take(data,q);assert.equal(data.readUInt32LE(q),0);assert.equal(q+4,data.length);
const [der]=take(certs,0),cert=new crypto.X509Certificate(der),fp=cert.fingerprint256.replaceAll(':','').toLowerCase();assert.equal(fp,fingerprint);assert(cert.publicKey.export({type:'spki',format:'der'}).equals(pub),'public key matches certificate');
const [sig]=take(sigs,0);assert.equal(sig.readUInt32LE(0),259);const [signature]=take(sig,4);assert(crypto.verify('RSA-SHA256',data,cert.publicKey,signature),'RSA signature');
const [dig]=take(digests,0);assert.equal(dig.readUInt32LE(0),259);const [signedDigest]=take(dig,4);const footer=Buffer.from(b.subarray(e));footer.writeUInt32LE(start,16);const sections=[b.subarray(0,start),b.subarray(c,e),footer];const chunks=sections.map(s=>{const h=Buffer.alloc(5);h[0]=0xa5;h.writeUInt32LE(s.length,1);return sha(Buffer.concat([h,s]));});const h=Buffer.alloc(5);h[0]=0x5a;h.writeUInt32LE(3,1);assert(sha(Buffer.concat([h,...chunks])).equals(signedDigest),'signed ZIP content digest');return {certificateSha256:fp,rsaSha256Signature:true,zipContentDigest:true};}

module.exports={unzip,verify};
