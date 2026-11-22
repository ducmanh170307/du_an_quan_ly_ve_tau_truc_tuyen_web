const { randomBytes } = require('node:crypto');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { sql, getPool } = require('../config/db');
const { hashPassword, verifyPassword } = require('../utils/password');
const {
  SESSION_COOKIE, sessionCookieOptions, hashSessionToken,
  readSessionHash, rejectSession, findSessionUser
} = require('../utils/session');

const router = express.Router();
const SESSION_SECONDS = 8 * 60 * 60;

// Hash mau de chi phi kiem tra mat khau tuong tu khi khong tim thay tai khoan.
const FALLBACK_PASSWORD_HASH =
  'scrypt-v1$bd09e8caeffd7f84329c5a432af8b662$' +
  '804108942f0fefc37f06b892f088081addda0ef3e30fad7c739bb1a7b1447f3e' +
  '454c5b384924f4de4382c4c844efcf0368469d0554d2a0414668ca2eec6a74e0';

// Moi IP co gioi han rieng cho cac thao tac tai khoan.
const registrationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    message: 'Bạn gửi quá nhiều yêu cầu đăng ký. Vui lòng thử lại sau.'
  }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    message: 'Bạn gửi quá nhiều yêu cầu đăng nhập. Vui lòng thử lại sau.'
  }
});

const passwordChangeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    message: 'Bạn gửi quá nhiều yêu cầu đổi mật khẩu. Vui lòng thử lại sau.'
  }
});

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

function invalidInput(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function readEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (
    email.length > 254 || !email.isWellFormed()
    || /[\u0000-\u001f\u007f]/u.test(email)
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)
  ) {
    throw invalidInput('Email không hợp lệ.');
  }
  return email;
}

// Chi gui ve cac truong ho so can hien thi.
function publicUser(user) {
  return {
    id: user.id,
    full_name: user.full_name,
    email: user.email,
    phone: user.phone,
    role: user.role
  };
}

function readFullName(value) {
  const fullName = typeof value === 'string' ? value.trim() : '';
  if (
    fullName.length < 2 || fullName.length > 100 || !fullName.isWellFormed()
    || /[\u0000-\u001f\u007f]/u.test(fullName)
  ) {
    throw invalidInput('Họ tên phải từ 2 đến 100 ký tự hợp lệ.');
  }
  return fullName;
}

function readPhone(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw invalidInput('Số điện thoại phải được nhập dạng chuỗi.');
  }
  const phone = value.trim();
  if (phone && !/^\+?[0-9]{8,15}$/u.test(phone)) {
    throw invalidInput('Số điện thoại gồm 8–15 chữ số, có thể bắt đầu bằng +.');
  }
  return phone || null;
}

function validateRegistration(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidInput('Vui lòng gửi thông tin đăng ký dạng JSON.');
  }

  const fullName = readFullName(body.full_name);
  const email = readEmail(body.email);

  if (typeof body.password !== 'string') {
    throw invalidInput('Vui lòng nhập mật khẩu.');
  }

  const phone = readPhone(body.phone);
  return { fullName, email, password: body.password, phone };
}

// POST /api/auth/register
router.post('/register', registrationLimiter, async (req, res) => {
  try {
    const input = validateRegistration(req.body);
    const passwordHash = await hashPassword(input.password);
    const pool = await getPool();

    const result = await pool.request()
      .input('full_name', sql.NVarChar(100), input.fullName)
      .input('email', sql.NVarChar(254), input.email)
      .input('password_hash', sql.VarChar(255), passwordHash)
      .input('phone', sql.VarChar(20), input.phone)
      .query(`
        INSERT INTO dbo.Users (
          full_name, email, password_hash, phone, [role]
        )
        OUTPUT
          INSERTED.id,
          INSERTED.full_name,
          INSERTED.email,
          INSERTED.phone,
          INSERTED.[role]
        VALUES (
          @full_name, @email, @password_hash, @phone, 'CUSTOMER'
        );
      `);

    const user = result.recordset[0];
    res.status(201).json({
      ok: true,
      message: 'Đăng ký tài khoản thành công.',
      user: publicUser(user)
    });
  } catch (error) {
    if (error.status === 400 || error.code === 'PASSWORD_INVALID') {
      return res.status(400).json({ ok: false, message: error.message });
    }

    const number = error.number ?? error.originalError?.info?.number;
    if (number === 2601 || number === 2627) {
      return res.status(409).json({
        ok: false,
        message: 'Email đã được sử dụng.'
      });
    }

    console.error('Lỗi đăng ký:', error.code || 'UNKNOWN');
    res.status(500).json({
      ok: false,
      message: 'Không thể đăng ký lúc này. Vui lòng thử lại sau.'
    });
  }
});

function validateLogin(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidInput('Vui lòng gửi thông tin đăng nhập dạng JSON.');
  }
  const email = readEmail(body.email);
  if (typeof body.password !== 'string' || body.password.length === 0) {
    throw invalidInput('Vui lòng nhập mật khẩu.');
  }
  return { email, password: body.password };
}

function rejectLogin(res) {
  return res.status(401).json({
    ok: false,
    message: 'Email hoặc mật khẩu không đúng.'
  });
}

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res) => {
  let credentials;
  try {
    credentials = validateLogin(req.body);
  } catch (error) {
    return res.status(400).json({ ok: false, message: error.message });
  }

  const { email, password } = credentials;
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('email', sql.NVarChar(254), email)
      .query(`
        SELECT id, full_name, email, phone, [role], password_hash
        FROM dbo.Users
        WHERE email = @email AND is_active = 1;
      `);
    const user = result.recordset[0];
    const matches = await verifyPassword(
      password, user?.password_hash ?? FALLBACK_PASSWORD_HASH
    );
    if (!user || !matches) return rejectLogin(res);

    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashSessionToken(token);

    // Giu khoa tai khoan cho den khi ghi xong phien de dong bo voi viec doi mat khau.
    const session = await pool.request()
      .input('token_hash', sql.VarBinary(32), tokenHash)
      .input('user_id', sql.Int, user.id)
      .input('email', sql.NVarChar(254), email)
      .input('password_hash', sql.VarChar(255), user.password_hash)
      .input('ttl_seconds', sql.Int, SESSION_SECONDS)
      .query(`
        DECLARE @created_at DATETIME2 = SYSUTCDATETIME();

        INSERT INTO dbo.UserSessions (token_hash, user_id, created_at, expires_at)
        OUTPUT INSERTED.user_id
        SELECT @token_hash, id, @created_at, DATEADD(SECOND, @ttl_seconds, @created_at)
        FROM dbo.Users WITH (UPDLOCK, HOLDLOCK)
        WHERE id = @user_id AND email = @email AND is_active = 1
          AND password_hash COLLATE Latin1_General_100_BIN2 = @password_hash;
      `);
    if (!session.recordset[0]) return rejectLogin(res);

    res.cookie(SESSION_COOKIE, token, {
      ...sessionCookieOptions(req),
      maxAge: SESSION_SECONDS * 1000
    });
    res.json({
      ok: true,
      message: 'Đăng nhập thành công.',
      user: publicUser(user)
    });
  } catch (error) {
    console.error('Lỗi đăng nhập:', error.code || 'UNKNOWN');
    res.status(500).json({
      ok: false,
      message: 'Không thể đăng nhập lúc này. Vui lòng thử lại sau.'
    });
  }
});

function isBookingId(value) {
  return typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 2147483647;
}

// GET /api/auth/me
router.get('/me', async (req, res) => {
  const tokenHash = readSessionHash(req);
  if (!tokenHash) return rejectSession(res);

  try {
    const pool = await getPool();
    const user = await findSessionUser(pool, tokenHash);
    if (!user) return rejectSession(res);
    res.json({ ok: true, user: publicUser(user) });
  } catch (error) {
    console.error('Lỗi đọc phiên đăng nhập:', error.code || 'UNKNOWN');
    res.status(500).json({
      ok: false,
      message: 'Không thể kiểm tra phiên lúc này. Vui lòng thử lại sau.'
    });
  }
});

// GET /api/auth/me/bookings
router.get('/me/bookings', async (req, res) => {
  const tokenHash = readSessionHash(req);
  if (!tokenHash) return rejectSession(res);

  const { before_id: before } = req.query;
  if (before !== undefined && !isBookingId(before)) {
    return res.status(400).json({ ok: false, message: 'Mốc tải đơn không hợp lệ.' });
  }

  const pageSize = 10;
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('token_hash', sql.VarBinary(32), tokenHash)
      .input('before_id', sql.Int, before === undefined ? null : Number(before))
      .input('fetch_count', sql.Int, pageSize + 1)
      .query(`
        DECLARE @now DATETIME2 = SYSUTCDATETIME();

        SELECT recent.*
        FROM dbo.UserSessions AS s
        INNER JOIN dbo.Users AS u ON u.id = s.user_id
        LEFT JOIN dbo.Bookings AS anchor
          ON anchor.id = @before_id AND anchor.user_id = u.id
        OUTER APPLY (
          SELECT TOP (@fetch_count)
            booking.id, booking.code, booking.created_at, booking.expires_at,
            booking.total_amount,
            CASE
              WHEN booking.status = 'PENDING_PAYMENT' AND booking.expires_at <= @now
                THEN 'EXPIRED'
              ELSE booking.status
            END AS status,
            trip.code AS trip_code, trip.departure_at,
            origin.name AS origin_name, destination.name AS destination_name,
            (
              SELECT COUNT(*) FROM dbo.BookingItems AS item WHERE item.booking_id = booking.id
            ) AS seat_count
          FROM dbo.Bookings AS booking
          INNER JOIN dbo.Trips AS trip ON trip.id = booking.trip_id
          INNER JOIN dbo.Stations AS origin ON origin.id = trip.origin_id
          INNER JOIN dbo.Stations AS destination ON destination.id = trip.destination_id
          WHERE booking.user_id = u.id
            AND (
              @before_id IS NULL
              OR booking.created_at < anchor.created_at
              OR (booking.created_at = anchor.created_at AND booking.id < anchor.id)
            )
          ORDER BY booking.created_at DESC, booking.id DESC
        ) AS recent
        WHERE s.token_hash = @token_hash AND s.expires_at > @now AND u.is_active = 1
        ORDER BY recent.created_at DESC, recent.id DESC;
      `);

    const rows = result.recordset;
    if (rows.length === 0) return rejectSession(res);
    // OUTER APPLY tra mot dong NULL khi tai khoan da dang nhap nhung trang nay rong.
    const bookings = rows.filter(row => row.id !== null);
    const items = bookings.slice(0, pageSize);
    res.json({
      ok: true,
      items,
      next_before_id: bookings.length > pageSize ? items.at(-1).id : null
    });
  } catch (error) {
    console.error('Lỗi đọc đơn của khách hàng:', error.code || 'UNKNOWN');
    res.status(500).json({
      ok: false,
      message: 'Không tải được danh sách đơn. Vui lòng thử lại.'
    });
  }
});

const cancellationErrors = new Map([
  [51101, [400, 'INVALID_BOOKING', 'Mã đơn không hợp lệ.']],
  [51102, [404, 'BOOKING_NOT_FOUND', 'Không tìm thấy đơn của bạn.']],
  [51103, [409, 'BOOKING_PAID', 'Đơn đã thanh toán. Vui lòng tải lại danh sách đơn.']],
  [51104, [503, 'BOOKING_BUSY', 'Chuyến đang có giao dịch khác. Vui lòng thử lại.']]
]);

// POST /api/auth/me/bookings/:bookingId/cancel
router.post('/me/bookings/:bookingId/cancel', async (req, res) => {
  const tokenHash = readSessionHash(req);
  if (!tokenHash) return rejectSession(res);

  if (!req.is('application/json')) {
    return res.status(415).json({ ok: false, message: 'Yêu cầu hủy đơn phải gửi dữ liệu JSON.' });
  }
  if (!isBookingId(req.params.bookingId)) {
    return res.status(400).json({ ok: false, message: 'Mã đơn không hợp lệ.' });
  }

  const bookingId = Number(req.params.bookingId);
  try {
    const pool = await getPool();
    const user = await findSessionUser(pool, tokenHash);
    if (!user) return rejectSession(res);

    const result = await pool.request()
      .input('user_id', sql.Int, user.id)
      .input('booking_id', sql.Int, bookingId)
      .execute('dbo.CancelBookingHold');

    const booking = result.recordset[0];
    if (booking?.id !== bookingId || typeof booking.code !== 'string'
        || (booking.status !== 'CANCELLED' && booking.status !== 'EXPIRED')) {
      throw new Error('Invalid cancellation result');
    }

    res.json({
      ok: true,
      booking: { id: booking.id, code: booking.code, status: booking.status }
    });
  } catch (error) {
    const number = error.number ?? error.originalError?.info?.number;
    if (number === 51105) return rejectSession(res);

    const mapped = cancellationErrors.get(number === 1205 ? 51104 : number);
    if (mapped) {
      const [status, code, message] = mapped;
      if (status === 503) res.set('Retry-After', '1');
      return res.status(status).json({ ok: false, code, message });
    }

    console.error('Lỗi hủy đơn:', error.code || 'UNKNOWN', number ?? '');
    res.status(500).json({ ok: false, message: 'Không thể hủy đơn lúc này. Vui lòng thử lại.' });
  }
});

function validateProfileUpdate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidInput('Vui lòng gửi thông tin hồ sơ dạng JSON.');
  }

  const fields = Object.keys(body);
  if (fields.length === 0) {
    throw invalidInput('Hãy gửi họ tên hoặc số điện thoại cần cập nhật.');
  }
  if (fields.some(field => field !== 'full_name' && field !== 'phone')) {
    throw invalidInput('Bạn chỉ có thể cập nhật họ tên và số điện thoại.');
  }

  const fullName = Object.hasOwn(body, 'full_name') ? readFullName(body.full_name) : null;
  const updatePhone = Object.hasOwn(body, 'phone');
  const phone = updatePhone ? readPhone(body.phone) : null;
  return { fullName, updatePhone, phone };
}

// PATCH /api/auth/me
router.patch('/me', async (req, res) => {
  const tokenHash = readSessionHash(req);
  if (!tokenHash) return rejectSession(res);

  if (!req.is('application/json')) {
    return res.status(415).json({
      ok: false,
      message: 'Yêu cầu cập nhật hồ sơ phải gửi dữ liệu JSON.'
    });
  }

  let profile;
  try {
    profile = validateProfileUpdate(req.body);
  } catch (error) {
    return res.status(400).json({ ok: false, message: error.message });
  }

  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('token_hash', sql.VarBinary(32), tokenHash)
      .input('full_name', sql.NVarChar(100), profile.fullName)
      .input('update_phone', sql.Bit, profile.updatePhone)
      .input('phone', sql.VarChar(20), profile.phone)
      .query(`
        UPDATE u
        SET full_name = COALESCE(@full_name, u.full_name),
            phone = CASE WHEN @update_phone = 1 THEN @phone ELSE u.phone END,
            updated_at = SYSUTCDATETIME()
        OUTPUT INSERTED.id, INSERTED.full_name, INSERTED.email,
               INSERTED.phone, INSERTED.[role]
        FROM dbo.Users AS u
        INNER JOIN dbo.UserSessions AS s ON s.user_id = u.id
        WHERE s.token_hash = @token_hash
          AND s.expires_at > SYSUTCDATETIME()
          AND u.is_active = 1;
      `);

    const user = result.recordset[0];
    if (!user) return rejectSession(res);
    res.json({
      ok: true,
      message: 'Cập nhật hồ sơ thành công.',
      user: publicUser(user)
    });
  } catch (error) {
    console.error('Lỗi cập nhật hồ sơ:', error.code || 'UNKNOWN');
    res.status(500).json({
      ok: false,
      message: 'Không thể cập nhật hồ sơ lúc này. Vui lòng thử lại sau.'
    });
  }
});

function validatePasswordChange(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2) {
    throw invalidInput('Vui lòng gửi mật khẩu hiện tại và mật khẩu mới.');
  }

  const { current_password: currentPassword, new_password: newPassword } = body;
  if (typeof currentPassword !== 'string' || !currentPassword) {
    throw invalidInput('Vui lòng nhập mật khẩu hiện tại.');
  }
  if (typeof newPassword !== 'string' || !newPassword) {
    throw invalidInput('Vui lòng nhập mật khẩu mới.');
  }
  if (currentPassword === newPassword) {
    throw invalidInput('Mật khẩu mới phải khác mật khẩu hiện tại.');
  }
  return { currentPassword, newPassword };
}

// POST /api/auth/me/password
router.post('/me/password', passwordChangeLimiter, async (req, res) => {
  const tokenHash = readSessionHash(req);
  if (!tokenHash) return rejectSession(res);

  if (!req.is('application/json')) {
    return res.status(415).json({
      ok: false,
      message: 'Yêu cầu đổi mật khẩu phải gửi dữ liệu JSON.'
    });
  }

  try {
    const { currentPassword, newPassword } = validatePasswordChange(req.body);
    const pool = await getPool();
    const session = await pool.request()
      .input('token_hash', sql.VarBinary(32), tokenHash)
      .query(`
        SELECT u.id, u.password_hash
        FROM dbo.UserSessions AS s
        INNER JOIN dbo.Users AS u ON u.id = s.user_id
        WHERE s.token_hash = @token_hash
          AND s.expires_at > SYSUTCDATETIME()
          AND u.is_active = 1;
      `);
    const user = session.recordset[0];
    if (!user) return rejectSession(res);

    if (!await verifyPassword(currentPassword, user.password_hash)) {
      return res.status(400).json({ ok: false, message: 'Mật khẩu hiện tại không đúng.' });
    }

    const newHash = await hashPassword(newPassword);
    const result = await pool.request()
      .input('token_hash', sql.VarBinary(32), tokenHash)
      .input('user_id', sql.Int, user.id)
      .input('old_password_hash', sql.VarChar(255), user.password_hash)
      .input('new_password_hash', sql.VarChar(255), newHash)
      .query(`
        SET NOCOUNT ON;
        SET XACT_ABORT ON;
        DECLARE @locked_user_id INT;
        DECLARE @changed BIT = 0;

        BEGIN TRY
          BEGIN TRANSACTION;

          SELECT @locked_user_id = id
          FROM dbo.Users WITH (UPDLOCK, HOLDLOCK)
          WHERE id = @user_id AND is_active = 1
            AND password_hash COLLATE Latin1_General_100_BIN2 = @old_password_hash;

          IF @locked_user_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM dbo.UserSessions WITH (UPDLOCK, HOLDLOCK)
            WHERE token_hash = @token_hash AND user_id = @locked_user_id
              AND expires_at > SYSUTCDATETIME()
          )
          BEGIN
            UPDATE dbo.Users
            SET password_hash = @new_password_hash, updated_at = SYSUTCDATETIME()
            WHERE id = @locked_user_id;

            DELETE FROM dbo.UserSessions WHERE user_id = @locked_user_id;
            SET @changed = 1;
          END;

          COMMIT TRANSACTION;
          SELECT @changed AS changed;
        END TRY
        BEGIN CATCH
          IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
          THROW;
        END CATCH;
      `);
    if (!result.recordset[0]?.changed) return rejectSession(res);

    res.clearCookie(SESSION_COOKIE, sessionCookieOptions(req));
    res.json({
      ok: true,
      message: 'Đã đổi mật khẩu. Vui lòng đăng nhập bằng mật khẩu mới.'
    });
  } catch (error) {
    if (error.status === 400 || error.code === 'PASSWORD_INVALID') {
      return res.status(400).json({ ok: false, message: error.message });
    }
    console.error('Lỗi đổi mật khẩu:', error.code || 'UNKNOWN');
    res.status(500).json({
      ok: false,
      message: 'Không thể đổi mật khẩu lúc này. Vui lòng thử lại sau.'
    });
  }
});

// POST /api/auth/logout
router.post('/logout', async (req, res) => {
  // API nhan JSON de tranh form gui tu website khac.
  if (!req.is('application/json')) {
    return res.status(415).json({
      ok: false,
      message: 'Yêu cầu đăng xuất phải gửi dữ liệu JSON.'
    });
  }

  const tokenHash = readSessionHash(req);
  try {
    if (tokenHash) {
      const pool = await getPool();
      await pool.request()
        .input('token_hash', sql.VarBinary(32), tokenHash)
        .query(`
          DELETE FROM dbo.UserSessions
          WHERE token_hash = @token_hash;
        `);
    }

    res.clearCookie(SESSION_COOKIE, sessionCookieOptions(req));
    res.json({ ok: true, message: 'Đăng xuất thành công.' });
  } catch (error) {
    console.error('Lỗi đăng xuất:', error.code || 'UNKNOWN');
    res.status(500).json({
      ok: false,
      message: 'Không thể đăng xuất lúc này. Vui lòng thử lại sau.'
    });
  }
});

module.exports = router;