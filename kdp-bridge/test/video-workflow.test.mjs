import test from 'node:test';
import assert from 'node:assert/strict';
import {route,openable,contentBlockers,classifyUpload} from '../extension/policy.js';

test('saved hardcover and paperback editions have independent identity',()=>{
  const hc=route('https://kdp.amazon.com/en_US/print-setup/hardcover/MDYZRKK4ZHV/content');
  const pb=route('https://kdp.amazon.com/en_US/print-setup/paperback/MDYZRKK4ZHV/content');
  assert.equal(hc.edition,'hardcover');
  assert.equal(pb.edition,'paperback');
  assert.notEqual(hc.path,pb.path);
  assert.equal(openable('https://kdp.amazon.com/en_US/title-setup/paperback/new/details'),false);
});
test('KDP cover and preview errors are separate blockers',()=>{
  const state=contentBlockers('Launch Cover Creator to create your required cover. Please preview and approve your book. No Cover Uploaded');
  assert.equal(state.cover_missing,true);
  assert.equal(state.preview_approval_required,true);
  assert.equal(state.saving,false);
});
test('saving and unsaved changes must stop navigation',()=>{
  assert.equal(contentBlockers('Saving...').saving,true);
  assert.equal(contentBlockers('You have unsaved changes. Continue without Saving?').unsaved_changes,true);
});
test('a file picker and a dispatched upload never prove Amazon acceptance',()=>{
  const f='Corinthians_Joel_6x9_Optimized_300dpi.pdf';
  assert.equal(classifyUpload('Select a file to upload',f),'unverified');
  assert.equal(classifyUpload('Upload manuscript',f),'unverified');
  assert.equal(classifyUpload(f+' Uploading 73%',f),'processing');
  assert.equal(classifyUpload('Upload failed: file rejected',f),'rejected_or_error');
  assert.equal(classifyUpload(f+' successfully uploaded',f),'accepted_observed');
  assert.equal(classifyUpload('OtherBook.pdf successfully uploaded',f),'unverified');
});
test('generic success or duplicate title text alone cannot mark the file accepted',()=>{
  assert.equal(classifyUpload('Your files have been uploaded'),'unverified');
  assert.equal(classifyUpload('Cover has been approved, but no filename is listed'),'unverified');
});
