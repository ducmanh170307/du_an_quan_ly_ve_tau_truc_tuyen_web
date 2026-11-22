const { createHash } = require('node:crypto');
const { sql, getPool } = require('../config/db');

const SESSION_COOKIE = 'train_session';

function sessionCookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production' || req.secure,
    path: '/'
  };
}

function hashSessionToken(token) {
  return createHash('sha256').update(token).digest();
}

function readSessionHash(req) {
  const prefix = SESSION_COOKIE + '=';
  const cookies = (req.get('Cookie') ?? '').split(';')
    .map(part => part.trim())
    .filter(part => part.startsWith(prefix));
  if (cookies.length !== 1) return null;
  const token = cookies[0].slice(prefix.length);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? hashSessionToken(token) : null;
}

function rejectSession(res) {
  return res.status(401).json({
    ok: false,
    message: 'Bạn chưa đăng nhập hoặc phiên đăng nhập đã hết hạn.'
  });
}

async function findSessionUser(pool, tokenHash) {
  const result = await pool.request()
    .input('token_hash', sql.VarBinary(32), tokenHash)
    .query(`
      SELECT u.id, u.full_name, u.email, u.phone, u.[role]
      FROM dbo.UserSessions AS s
      INNER JOIN dbo.Users AS u ON u.id = s.user_id
      WHERE s.token_hash = @token_hash AND s.expires_at > SYSUTCDATETIME() AND u.is_active = 1;
    `);
  return result.recordset[0];
}

async function requireSession(req, res, next) {
  res.set('Cache-Control', 'no-store');
  const tokenHash = readSessionHash(req);
  if (!tokenHash) return rejectSession(res);

  const pool = await getPool();
  const user = await findSessionUser(pool, tokenHash);
  if (!user) return rejectSession(res);

  req.user = user;
  req.db = pool;
  next();
}

module.exports = {
  SESSION_COOKIE, sessionCookieOptions, hashSessionToken, readSessionHash,
  rejectSession, findSessionUser, requireSession
};
