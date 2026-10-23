// Read-only JVM class disassembly for the bundled SDK; no SDK code is executed.
import fs from 'node:fs'
import path from 'node:path'
const op = `nop aconst_null iconst_m1 iconst_0 iconst_1 iconst_2 iconst_3 iconst_4 iconst_5 lconst_0 lconst_1 fconst_0 fconst_1 fconst_2 dconst_0 dconst_1 bipush sipush ldc ldc_w ldc2_w iload lload fload dload aload iload_0 iload_1 iload_2 iload_3 lload_0 lload_1 lload_2 lload_3 fload_0 fload_1 fload_2 fload_3 dload_0 dload_1 dload_2 dload_3 aload_0 aload_1 aload_2 aload_3 iaload laload faload daload aaload baload caload saload istore lstore fstore dstore astore istore_0 istore_1 istore_2 istore_3 lstore_0 lstore_1 lstore_2 lstore_3 fstore_0 fstore_1 fstore_2 fstore_3 dstore_0 dstore_1 dstore_2 dstore_3 astore_0 astore_1 astore_2 astore_3 iastore lastore fastore dastore aastore bastore castore sastore pop pop2 dup dup_x1 dup_x2 dup2 dup2_x1 dup2_x2 swap iadd ladd fadd dadd isub lsub fsub dsub imul lmul fmul dmul idiv ldiv fdiv ddiv irem lrem frem drem ineg lneg fneg dneg ishl lshl ishr lshr iushr lushr iand land ior lor ixor lxor iinc i2l i2f i2d l2i l2f l2d f2i f2l f2d d2i d2l d2f i2b i2c i2s lcmp fcmpl fcmpg dcmpl dcmpg ifeq ifne iflt ifge ifgt ifle if_icmpeq if_icmpne if_icmplt if_icmpge if_icmpgt if_icmple if_acmpeq if_acmpne goto jsr ret tableswitch lookupswitch ireturn lreturn freturn dreturn areturn return getstatic putstatic getfield putfield invokevirtual invokespecial invokestatic invokeinterface invokedynamic new newarray anewarray arraylength athrow checkcast instanceof monitorenter monitorexit wide multianewarray ifnull ifnonnull goto_w jsr_w breakpoint`.split(' ')
function inspect(file) {
  const b = fs.readFileSync(file); let p = 8
  const u1 = () => b[p++]; const u2 = () => { const n=b.readUInt16BE(p); p+=2; return n }; const u4 = () => { const n=b.readUInt32BE(p); p+=4; return n }
  const cp = new Array(u2())
  for (let i=1;i<cp.length;i++) {
    const t=u1()
    if(t===1) { const n=u2(); cp[i]=b.toString('utf8',p,p+n);p+=n }
    else if([7,8,16,19,20].includes(t)) cp[i]={t,a:u2()}
    else if([9,10,11,12,18,17].includes(t)) cp[i]={t,a:u2(),b:u2()}
    else if(t===15) cp[i]={t,a:u1(),b:u2()}
    else if([3,4].includes(t)) {cp[i]=t===3?b.readInt32BE(p):b.readFloatBE(p);p+=4}
    else if([5,6].includes(t)) {cp[i]=String(b.readBigInt64BE(p));p+=8;i++}
    else throw Error('constant '+t)
  }
  const ref=(i)=> {const v=cp[i];return v&&typeof v==='object' ? ref(v.a)+(v.b!==undefined?':'+ref(v.b):'') : String(v)}
  const attrs=()=> { const a=[];for(let n=u2();n--;){const name=ref(u2()),len=u4(),start=p;p+=len;a.push({name,start,len})}return a }
  u2(); console.log('CLASS '+ref(u2()));u2();for(let n=u2();n--;)u2()
  for(let n=u2();n--;){u2();const name=ref(u2()),type=ref(u2());for(const a of attrs())if(a.name==='ConstantValue')console.log('FIELD '+name+' '+type+' = '+ref(b.readUInt16BE(a.start)))}
  for(let n=u2();n--;){u2();const name=ref(u2()),type=ref(u2());const a=attrs().find(x=>x.name==='Code');console.log('METHOD '+name+' '+type);if(!a)continue
    const start=a.start+8,len=b.readUInt32BE(a.start+4),c=b.subarray(start,start+len)
    for(let i=0;i<c.length;){const at=i,o=c[i++],m=op[o]||String(o);let arg=''
      if(o===18){arg=ref(c[i++])}
      else if([19,20,178,179,180,181,182,183,184,185,186,187,189,192,193,197].includes(o)){arg=ref(c.readUInt16BE(i));i+=2;if(o===185||o===186)i+=2;if(o===197)arg+=' dims='+c[i++]}
      else if(o===16){arg=c.readInt8(i++)}
      else if(o===17){arg=c.readInt16BE(i);i+=2}
      else if((o>=21&&o<=25)||(o>=54&&o<=58)||o===169||o===188){arg=c[i++]}
      else if(o===132){arg=c[i++]+' '+c.readInt8(i++)}
      else if((o>=153&&o<=168)||o===198||o===199){arg=at+c.readInt16BE(i);i+=2}
      else if(o===200||o===201){arg=at+c.readInt32BE(i);i+=4}
      else if(o===170){i=(i+3)&~3;const low=c.readInt32BE(i+4),high=c.readInt32BE(i+8);arg='default '+(at+c.readInt32BE(i));i+=12;for(let k=low;k<=high;k++){arg+=' '+k+':'+(at+c.readInt32BE(i));i+=4}}
      else if(o===171){i=(i+3)&~3;arg='default '+(at+c.readInt32BE(i));const n=c.readInt32BE(i+4);i+=8;for(let k=0;k<n;k++){arg+=' '+c.readInt32BE(i)+':'+(at+c.readInt32BE(i+4));i+=8}}
      else if(o===196){arg=op[c[i++]]+' '+c.readUInt16BE(i);i+=2;if(c[i-3]===132)i+=2}
      console.log(at+' '+m+(arg!==''?' '+arg:''))
    }
    let e=start+len;const count=b.readUInt16BE(e);e+=2;for(let i=0;i<count;i++,e+=8)console.log('CATCH '+b.readUInt16BE(e)+'..'+b.readUInt16BE(e+2)+' -> '+b.readUInt16BE(e+4)+' '+ref(b.readUInt16BE(e+6)))
  }
}
for (const file of process.argv.slice(2)) inspect(path.resolve(file))
