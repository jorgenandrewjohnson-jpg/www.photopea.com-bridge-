// Installed on demand in the isolated world of the selected top-level document.
(() => {
  if (globalThis.kdpPage) return;
  const controls = new Map();
  let transfer;
  const normal = value => (value || '').replace(/\s+/g,' ').trim();
  const visible = el => el?.isConnected && el.getClientRects().length && getComputedStyle(el).visibility === 'visible';
  const alerts = () => [...new Set([...document.querySelectorAll('[role="alert"],.a-alert-error,.a-alert-warning,.error,.warning')].filter(visible).map(el=>normal(el.innerText).slice(0,600)).filter(Boolean))];
  const label = el => normal(el.getAttribute('aria-label') || el.getAttribute('title') || [...(el.labels || [])].map(l=>l.innerText).join(' ') || el.innerText || (['button','submit'].includes(el.type)?el.value:'') || el.placeholder || el.getAttribute('data-action') || el.name || el.id).slice(0,200);
  const identity = el => [el.id,el.name,label(el)].join(' ').toLowerCase();
  const allowedField = /(?:title|subtitle|author|contributor|first.?name|last.?name|keyword|description|series.?name|book.?order|language|book.?number)/i;
  const ordinary = /^(?:save (?:as draft|draft|and continue)|save changes|launch (?:cover creator|previewer|print previewer|online previewer)|preview (?:your )?book|next(?: page)?|previous(?: page)?|back|continue setup|edit (?:ebook|kindle ebook|paperback|hardcover) (?:details|content|pricing)|(?:\+\s*)?create (?:kindle ebook|paperback|hardcover|series)|(?:choose|select) (?:design|layout|template)|save (?:cover|and exit)|(?:paperback|hardcover|kindle ebook) (?:details|content|rights & pricing))$/i;
  const publication = /^publish (?:your |my )?(paperback|hardcover|kindle ebook|ebook)$/i;
  const positiveStage = (name,stage) => {
    if (/^publish /i.test(name)) return ['pricing','rights-and-pricing'].includes(stage);
    if (/^(launch|preview .*book)/i.test(name)) return stage==='content';
    if (/create (kindle ebook|paperback|hardcover|series)/i.test(name)) return ['create','bookshelf'].includes(stage);
    if (/^(choose|select|save cover|save and exit)/i.test(name)) return stage==='cover_creator';
    if (/^(next|previous|back)/i.test(name)) return ['cover_creator','previewer','bookshelf'].includes(stage);
    return ordinary.test(name);
  };
  // Discover actual controls, not just a short English button-label list.
  // Publishing, purchases, destructive account actions and external links stay
  // excluded; publication requires the separate owner-confirmed tool.
  const excluded = /(?:publish|place order|order proof|request proof|buy now|delete|remove book|sign out|log out|cancel account|payment method|bank account|tax information|delete title)/i;
  function allElements() {
    const found=[];
    const walk=root=>{
      for (const el of root.querySelectorAll('*')) {
        if (el.matches('input,select,textarea,[contenteditable=true],button,a,[role=button],[role=radio],[role=checkbox],[role=tab],[role=menuitem],[tabindex="0"],.a-button')) found.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    return found;
  }
  function fileKind(el,p) {
    if (p.stage!=='content' || p.edition_id==='new') return null;
    const own=identity(el)+' '+(el.getAttribute('accept')||'');
    const nearby=normal(el.closest('section,fieldset,[class*=upload],.a-box')?.innerText||el.parentElement?.parentElement?.innerText||'').slice(0,600).toLowerCase();
    if (/cover/i.test(own)) return 'cover';
    if (/manuscript|interior|book content/i.test(own)) return 'manuscript';
    const nearCover=/book cover|cover file|upload your cover/i.test(nearby);
    const nearInterior=/manuscript|upload your manuscript|interior/i.test(nearby);
    if(nearCover!==nearInterior) return nearCover?'cover':'manuscript';
    // Amazon sometimes places both file slots under one large container.
    // Only use their documented order if exactly two slots are present.
    const inputs=allElements().filter(x=>x.matches('input[type=file]'));
    if(inputs.length===2) return inputs.indexOf(el)===0?'manuscript':'cover';
    return null;
  }
  function capability(el,p) {
    if (el.matches(':disabled,[aria-disabled="true"]') || el.readOnly) return;
    if(el.matches('input[type=file]')) return fileKind(el,p);
    if(!visible(el)) return;
    const name=label(el);
    if(publication.test(name)) return ['pricing','rights-and-pricing'].includes(p.stage)?'publish':undefined;
    if(excluded.test(name)) return;
    if(el.matches('input[type=password],input[autocomplete=one-time-code]')) return;
    if(el.matches('textarea,select,[contenteditable=true],input:not([type]),input[type=text],input[type=number],input[type=search]')) {
      if(['details','content','series','cover_creator','pricing','rights-and-pricing'].includes(p.stage)) return 'fill';
    }
    if(el.matches('input[type=radio],input[type=checkbox],[role=radio],[role=checkbox]')) {
      if(['details','content','pricing','rights-and-pricing','cover_creator'].includes(p.stage)) return 'click';
    }
    if(el.matches('button,[role=button],[role=tab],[role=menuitem],[tabindex="0"],.a-button,a,input[type=submit],input[type=button]')) {
      const href=el.getAttribute('href');
      if(href && (href.startsWith('javascript:') || (href.startsWith('http') && !/^https:\/\/(?:kdp\.amazon\.com|cc\.amazon\.com)\//.test(href)))) return;
      if(!name || name.length>200) return;
      if(/(?:checkout|account|order|payment|cart|buy)/i.test(name)) return;
      return 'click';
    }
  }
  function safeText(value) {
    return (value || '').replace(/https?:\/\/[^\s<>]+/gi,'[link]').replace(/\b[\w-]{48,}\b/g,'[redacted]');
  }
  function check(p) {
    if (location.origin !== new URL(p.path).origin || (p.stage!=='cover_creator' && p.stage!=='previewer' && location.origin+location.pathname!==p.path)) throw Error('Page changed. Inspect again.');
    if (document.querySelector('input[type=password],input[autocomplete=one-time-code],input[name=captchaGuess],#captchacharacters,iframe[src*="captcha" i]') || /verify (?:you are|that you are) (?:a )?human|enter the characters you see|authentication required/i.test(document.body?.innerText.slice(0,2000))) throw Error('Amazon authentication or verification requires user interaction.');
    // The same KDP identifier may appear in multiple formats. Never treat the
    // URL's identifier alone as proof of the intended edition.
    if (p.stage==='content' && ['hardcover','paperback'].includes(p.edition)) {
      const heading=normal(document.body?.innerText||'').slice(0,9000);
      if (!new RegExp('\\b'+p.edition+'\\s+content\\b','i').test(heading))
        throw Error('Edition format is not confirmed by the visible Content heading');
    }
  }
  function fingerprint() {
    const form=[...document.querySelectorAll('input,select,textarea')].filter(el=>el.type!=='hidden' && el.type!=='password' && el.type!=='file').map(el=>[el.name,el.value,el.checked]);
    return JSON.stringify([location.href,document.body.innerText,form]);
  }
  let reviewed;
  function getControl(a,p,kind) {
    const record=controls.get(a.control_id);
    if (!record || record.href!==location.href || record.label!==label(record.el) || capability(record.el,p)!==kind || !record.el.isConnected) throw Error('Control changed. Inspect again.');
    return record.el;
  }
  globalThis.kdpPage = (op,a,p) => {
    check(p);
    if (op==='inspect') {
      controls.clear();
      const list=[];
      for (const el of allElements()) {
        const kind=capability(el,p);
        if (!kind) continue;
        const id=crypto.randomUUID(), name=label(el);
        controls.set(id,{el,label:name,href:location.href});
        const row=el.closest('tr,fieldset,section,[data-title-id],.a-box');
        list.push({control_id:id,kind,label:safeText(name),context:safeText(row?.innerText).slice(0,280),...(kind==='fill'?{value:safeText(el.value ?? el.innerText).slice(0,1200),options:el.tagName==='SELECT'?[...el.options].map(o=>({value:o.value,label:normal(o.textContent),selected:o.selected})).slice(0,100):undefined}:{}) ,...(kind==='click' && el.matches('input[type=radio],input[type=checkbox],[role=radio],[role=checkbox]')?{checked:el.checked??el.getAttribute('aria-checked')==='true',value:el.value??null}:{})});
      }
      return {title:safeText(document.title),page:p,controls:list,alerts:alerts().map(safeText),text:safeText(document.body.innerText).slice(0,28000)};
    }
    if (op==='processing') {
      const progress=[...document.querySelectorAll('progress,[role=progressbar],[aria-busy=true]')]
        .filter(visible).map(el=>({label:normal(el.getAttribute('aria-label')||el.innerText),
          value:el.value??el.getAttribute('aria-valuenow')??null,
          max:el.max??el.getAttribute('aria-valuemax')??null})).slice(0,20);
      return {page:p,alerts:alerts().map(safeText),progress,
        observed_text:safeText(document.body?.innerText||'').slice(0,9000),
        amazon_processing_verified:false};
    }
    if (op==='check') return true;
    if (op==='scroll') {window.scrollBy(0,a.y);return {y:scrollY};}
    if (op==='click') {
      const el=getControl(a,p,'click');
      el.click();
      return {dispatched:true,checked:el.checked??null,confirmation:'Inspect the destination and Amazon status.'};
    }
    if (op==='fill') {
      const el=getControl(a,p,'fill');
      if (el.isContentEditable) el.textContent=a.value;
      else {
        const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value')?.set;
        if (!setter) throw Error('Unsupported field');
        setter.call(el,a.value);
        if (el.value!==a.value) throw Error('Value rejected by field');
      }
      for (const event of ['input','change']) el.dispatchEvent(new Event(event,{bubbles:true}));
      return {entered:true,save_verified:false};
    }
    if (op==='upload_begin') {
      if (p.edition_id!==a.edition_id || p.edition!==a.edition || p.edition_id==='new' || p.stage!=='content') throw Error('Staged edition does not match this Content page');
      const input=getControl(a,p,a.kind);
      transfer={...a,input,parts:[],bytes:0};
      return true;
    }
    if (op==='upload_cancel') {transfer=null;return true;}
    if (op==='upload_chunk' || op==='upload_commit') {
      const f=transfer;
      if (!f || f.id!==a.id || f.input!==getControl(f,p,f.kind)) throw Error('Upload target changed');
      if (op==='upload_chunk') {
        if (a.index!==f.parts.length) throw Error('Unexpected chunk');
        const raw=atob(a.data), bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
        if (f.bytes+bytes.length>f.size) throw Error('File size mismatch');
        f.parts.push(bytes); f.bytes+=bytes.length; return true;
      }
      transfer=null;
      if (!f.size || f.bytes!==f.size) throw Error('Incomplete transfer');
      const file=new File(f.parts,f.name,{type:f.mime});
      const dt=new DataTransfer(); dt.items.add(file); f.input.files=dt.files;
      for (const event of ['input','change']) f.input.dispatchEvent(new Event(event,{bubbles:true}));
      return {dispatched:true,name:f.name,bytes:file.size,amazon_processing:'unverified'};
    }
    if (op==='review_publish' || op==='publish') {
      const el=getControl(a,p,'publish');
      const edition=publication.exec(label(el))?.[1].toLowerCase();
      const kind=edition?.includes('ebook')?'ebook':edition;
      const observed=p.edition?.includes('kindle')?'ebook':p.edition;
      if (!a.chat_approved || a.edition!==p.edition || p.edition_id!==a.edition_id || p.edition_id==='new' || kind!==observed) throw Error('Edition mismatch');
      const actualAlerts=alerts();
      if (JSON.stringify(actualAlerts)!==JSON.stringify(a.warnings) || [...document.querySelectorAll('.a-alert-error,[aria-invalid=true]')].some(visible)) throw Error('Resolve errors and review current warnings first');
      const lines=document.body.innerText.split('\n').map(normal);
      const values=[...document.querySelectorAll('input,select')].filter(visible).map(el=>normal(el.value));
      if (![a.title,a.price,a.rights].every(v=>[...lines,...values].includes(normal(v)))) throw Error('Title, price or rights could not be matched to this pricing page');
      if (op==='review_publish') {reviewed=fingerprint();return {button:label(el)};}
      const matches=reviewed && reviewed===fingerprint(); reviewed=null;
      if (!matches) throw Error('Pricing page changed after review');
      el.click();return {dispatched:true,submission_status:'unverified'};
    }
    throw Error('Unsupported page operation');
  };
})();
