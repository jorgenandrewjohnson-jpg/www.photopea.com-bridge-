const literal = value => JSON.stringify(value).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
const active = 'if (!app.documents.length) return fail("Open a document first."); var doc = app.activeDocument;';
const docInfo = 'return {name: doc.name, width: Number(doc.width), height: Number(doc.height), dpi: Number(doc.resolution)};';
const lookup = `
function byPath(path) {
  var container = doc;
  for (var i = 0; i < path.length; i++) {
    var found = null;
    if (!container.layers) return fail("Layer path does not point through a group: " + path[i]);
    for (var j = 0; j < container.layers.length; j++) {
      var candidate = container.layers[j];
      if (candidate.name !== path[i]) continue;
      if (found) return fail("Ambiguous layer name: " + path[i]);
      found = candidate;
    }
    if (!found) return fail("Layer not found: " + path[i]);
    container = found;
  }
  return container;
}
function describe(layer) {
  var kind = layer.kind === LayerKind.TEXT ? 'text' : layer.kind === LayerKind.SMARTOBJECT ? 'smart_object' : String(layer.typename);
  var info = {name: layer.name, kind: kind, visible: layer.visible};
  var bounds = layer.bounds;
  if (bounds) info.bounds = [bounds[0].value, bounds[1].value, bounds[2].value, bounds[3].value];
  if (layer.kind === LayerKind.TEXT) {
    var text = layer.textItem;
    info.text = text.contents;
    info.font = text.font;
    info.size = Math.round(text.size.value * 1000) / 1000;
    info.transform = JSON.parse(text.transform);
  }
  return info;
}
`;
const textHelpers = `
function addText(doc, a) {
  var layer = doc.artLayers.add();
  layer.kind = LayerKind.TEXT;
  layer.name = a.name;
  var text = layer.textItem;
  text.kind = TextType.POINTTEXT;
  text.contents = a.text;
  if (a.font) text.font = a.font;
  text.size = a.size;
  var color = new SolidColor();
  color.rgb.hexValue = a.color.slice(1);
  text.color = color;
  text.justification = {left: Justification.LEFT, center: Justification.CENTER, right: Justification.RIGHT}[a.alignment];
  text.position = [a.x, a.y];
  doc.activeLayer = layer;
  return layer;
}
`;
const transform = `
function transform(layer, a) {
  if (a.scale) layer.resize(a.scale, a.scale, AnchorPosition.MIDDLECENTER);
  if (a.rotation) layer.rotate(a.rotation, AnchorPosition.MIDDLECENTER);
  if (a.dx || a.dy) layer.translate(a.dx || 0, a.dy || 0);
}
`;
const topLeft = `
function place(layer, a) {
  if (a.scale) layer.resize(a.scale, a.scale, AnchorPosition.MIDDLECENTER);
  var bounds = layer.bounds;
  layer.translate(a.x - bounds[0].value, a.y - bounds[1].value);
  layer.name = a.name;
}
`;
function dataUrl(type, bytes) { return 'data:' + type + ';base64,' + bytes; }

function placeSteps(url, a) {
  return [{
    body: `${active}
var before=doc.layers.length;
app.open(${literal(url)}, null, true);
return {layersBefore: before};`
  }, {
    body: `${active}${topLeft}${lookup}
if (doc.layers.length === previous.layersBefore) return null;
if (doc.layers.length !== previous.layersBefore + 1 || doc.activeLayer.kind !== LayerKind.SMARTOBJECT)
 return fail("Photopea did not create an active Smart Object.");
var layer=doc.activeLayer; place(layer,${literal(a)}); return describe(layer);`,
    waitForResult: true
  }];
}

function validAsset(a, imageOnly = false) {
  const type = { png: 'image/png', jpg: 'image/jpeg', psd: 'image/vnd.adobe.photoshop' }[a.format];
  const bytes = Buffer.from(a.base64, 'base64');
  const magic = a.format === 'png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    : a.format === 'jpg' ? bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
      : bytes.subarray(0, 4).toString() === '8BPS';
  if (!magic || bytes.toString('base64') !== a.base64 || (imageOnly && a.format === 'psd')) {
    throw new Error('Asset must contain canonical base64 matching its declared file format.');
  }
  return { url: dataUrl(type, a.base64), bytes };
}

function reorderLayers(a) {
  const parent = a.path.slice(0, -1);
  if (literal(parent) !== literal(a.relative_to.slice(0, -1)) || literal(a.path) === literal(a.relative_to)) {
    throw new Error('Choose another layer in the same group.');
  }
  const parentLookup = parent.length ? `byPath(${literal(parent)})` : 'doc';
  const locate = `${active}${lookup}
var container=${parentLookup}, source=-1, anchor=-1;
if(container.photopeaBridgeError) return container;
for(var i=0;i<container.layers.length;i++){
 var layerName=container.layers[i].name;
 if(layerName===${literal(a.path.at(-1))}){
  if(source!==-1) return fail("The layer path is ambiguous.");
  source=i;
 }
 if(layerName===${literal(a.relative_to.at(-1))}){
  if(anchor!==-1) return fail("The reference path is ambiguous.");
  anchor=i;
 }
}
if(source<0 || anchor<0) return fail("The layer or reference was not found.");`;
  return { steps: [
    { body: `${locate}
container.layers[source].move(container.layers[anchor],ElementPlacement.${a.position === 'above' ? 'PLACEBEFORE' : 'PLACEAFTER'});
return true;` },
    { body: `${locate}
if(source!==anchor + (${a.position === 'above' ? -1 : 1})) return fail("Photopea did not reorder the layer.");
return describe(container.layers[source]);` }
  ] };
}

function editLayer(a) {
  const path = literal(a.path);
  const shared = `${active}${lookup} var layer=byPath(${path}); if(layer.photopeaBridgeError) return layer;`;
  let change;
  let verifyPath = a.path;
  let verify = '';
  switch (a.action) {
    case 'rename':
      verifyPath = [...a.path.slice(0, -1), a.name];
      change = `layer.name=${literal(a.name)};`;
      break;
    case 'visibility':
      change = `layer.visible=${a.visible};`;
      verify = `if(layer.visible!==${a.visible}) return fail("Photopea did not change visibility.");`;
      break;
    case 'text':
      change = `if(layer.kind!==LayerKind.TEXT) return fail("Layer is not editable text."); layer.textItem.contents=${literal(a.text)};`;
      verify = `if(layer.textItem.contents.replace(/\\r\\n|\\r/g,"\\n")!==${literal(a.text.replace(/\r\n|\r/g, '\n'))}) return fail("Photopea did not preserve the requested text.");`;
      break;
    case 'transform':
      change = `${transform} doc.activeLayer=layer; transform(doc.activeLayer,${literal(a)});`;
      break;
    case 'reorder':
      return reorderLayers(a);

  }
  return { steps: [
    { body: `${shared}
${change}
return true;` },
    { body: `${active}${lookup} var layer=byPath(${literal(verifyPath)}); if(layer.photopeaBridgeError) return layer;
${verify}
return describe(layer);` }
  ] };
}

export function makeOperation(tool, a) {
  const single = (body, extra = {}) => ({ steps: [{ body }], ...extra });
  switch (tool) {
    case 'photopea_open_document':
      if (a.mode === 'new') {
        if (a.width * a.height > 40_000_000) throw new Error('New document exceeds 40 megapixels.');
        return single(`var doc=app.documents.add(${a.width},${a.height},${a.dpi},${literal(a.name)},NewDocumentMode.RGB,DocumentFill.${a.background === 'white' ? 'WHITE' : 'TRANSPARENT'}); doc.name=${literal(a.name)}; ${docInfo}`);
      }
      if (a.mode === 'asset') return { steps: [
        { body: 'return app.documents.length;' },
        { bytes: validAsset(a).bytes },
        { body: `if(app.documents.length !== previous+1) return fail("Photopea did not open the file."); var doc=app.activeDocument;doc.name=${literal(a.name)};${docInfo}` }
      ] };
      return single(`var doc=null;
for(var i=0;i<app.documents.length;i++) {
  if(app.documents[i].name!==${literal(a.name)}) continue;
  if(doc) return fail("Multiple open documents have that exact name.");
  doc=app.documents[i];
}
if(!doc) return fail("Open the document in the paired workspace first.");
app.activeDocument=doc; ${docInfo}`);
    case 'photopea_add_text':
      return { steps: [
        { body: `${active}${textHelpers} var layer = addText(doc,${literal(a)}); return layer.name;` },
        { body: `${active}${lookup}
var layer=doc.activeLayer;
if(layer.kind!==LayerKind.TEXT || layer.name!==previous) return fail("The new text layer is no longer active.");
var bounds=layer.bounds;
${/\S/.test(a.text) ? 'if(bounds[0].value===bounds[2].value && bounds[1].value===bounds[3].value) return null;' : ''}
${a.rotation ? `layer.rotate(${a.rotation}, AnchorPosition.MIDDLECENTER);` : ''}
return describe(doc.activeLayer);`, waitForResult: /\S/.test(a.text) }
      ] };
    case 'photopea_place_image':
      return { steps: placeSteps(validAsset(a, true).url, { name: a.name, x: a.x, y: a.y, scale: a.scale }) };
    case 'photopea_manage_layers':
      if (a.action === 'list') return single(`${active}${lookup}
var remaining=250;
function list(group, depth) {
  var layers=[];
  for(var i=0;i<group.layers.length && remaining>0;i++) {
    remaining--; var layer=group.layers[i], item=describe(layer);
    if(item.text) item.text=item.text.slice(0,240);
    if(layer.typename==="LayerSet" && depth<12) item.children=list(layer,depth+1);
    layers.push(item);
  }
  return layers;
}
var layers=list(doc,0); return { document:doc.name, layers:layers, truncated:remaining===0 };`);
      return editLayer(a);
    case 'photopea_run_script':
      return single(a.script, { approval: a.script });
    case 'photopea_export': {
      const wireFormat = a.format === 'pdf' ? 'jpg' : a.format;
      // At 500 DPI, full-wrap hardcovers exceed the former 18MP PNG/PDF
      // conversion limit. Photopea's highest-quality JPEG compresses the
      // payload before transport; the server embeds it without re-encoding.
      const options = a.format === 'pdf' ? ':1' : a.format === 'jpg' ? ':' + a.quality : '';
      return { steps: [{ body: `${active}doc.saveToOE(${literal(wireFormat + options)}); ${docInfo}`, export: true }],
        format: a.format, wireFormat, name: a.name };
    }
  }
}

export function wrapStep(prefix, body, previous) {
  return `(function(){
var previous=${literal(previous ?? null)}, result;
function fail(message) { return {photopeaBridgeError:message}; }
try { result=(function(){\n${body}\n})(); }
catch(error) { app.echoToOE(${literal(prefix)}+JSON.stringify({ok:false,error:String(error).slice(0,800)})); return; }
if(result && result.photopeaBridgeError) app.echoToOE(${literal(prefix)}+JSON.stringify({ok:false,error:result.photopeaBridgeError}));
else app.echoToOE(${literal(prefix)}+JSON.stringify({ok:true,value:typeof result==="undefined"?null:result}));
})();`;
}
