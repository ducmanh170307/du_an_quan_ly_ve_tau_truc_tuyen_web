function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: 'INVALID_INPUT' });
}

function positiveId(value, name, max = 2147483647) {
  const number = typeof value === 'number' ? value
    : typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) ? Number(value) : 0;
  if (!Number.isInteger(number) || number < 1 || number > max) {
    throw invalid(name + ' không hợp lệ.');
  }
  return number;
}

function text(value, name, limit, optional = false) {
  const normalized = typeof value === 'string' ? value.trim() : null;
  if (normalized === null || (!optional && !normalized) || normalized.length > limit
      || !normalized.isWellFormed() || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw invalid(name + ' phải là chuỗi tối đa ' + limit + ' ký tự.');
  }
  return normalized;
}

function vietnamDate(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value)) throw invalid(name + ' không hợp lệ.');
  const midnight = new Date(value + 'T00:00:00.000Z');
  if (!Number.isFinite(+midnight) || midnight.getUTCFullYear() < 1900
      || midnight.getUTCFullYear() > 9998 || midnight.toISOString().slice(0, 10) !== value) {
    throw invalid(name + ' không hợp lệ.');
  }
  return new Date(+midnight - 7 * 3600000);
}

function vietnamDateTime(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?$/.test(value)) {
    throw invalid(name + ' không hợp lệ.');
  }
  vietnamDate(value.slice(0, 10), name);
  return new Date(value + '+07:00');
}

function jsonBody(req, res, next) {
  if (['POST', 'PATCH', 'DELETE'].includes(req.method) && !req.is('application/json')) {
    return res.status(415).json({ ok: false, message: 'Yêu cầu phải gửi dữ liệu JSON.' });
  }
  next();
}

module.exports = { invalid, positiveId, text, vietnamDate, vietnamDateTime, jsonBody };
