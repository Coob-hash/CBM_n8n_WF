const input = $input.first().json;
const integer = (value, fallback, min, name) => {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min) throw new Error(name + ' must be an integer >= ' + min);
  return n;
};
const requested = integer(input.limit, 1, 1, 'limit');
let ids = input.global_ids || [];
if (typeof ids === 'string') {try {ids = JSON.parse(ids);} catch {throw new Error('global_ids must be a JSON array of IFC GlobalIds');}}
if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_$]{22}$/.test(id)))
  throw new Error('global_ids must contain at most 100 valid IFC GlobalIds');
const search = String(input.search || '').trim();
const model = String(input.model_version || '').trim();
if (search.length > 200) throw new Error('Search is too long');
if (model && !/^[A-Za-z0-9_. -]+\.ifc$/.test(model)) throw new Error('Invalid model version');
return [{json:{limit:Math.min(requested,20),requested_limit:requested,
 offset:integer(input.offset,0,0,'offset'),global_ids:[...new Set(ids)].join(','),search,model_version:model}}];
