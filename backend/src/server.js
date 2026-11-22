const path = require('node:path');
const express = require('express');
const { sql, getPool } = require('./config/db');
const tripsRouter = require('./routes/trips.routes');
const authRouter = require('./routes/auth.routes');
const bookingsRouter = require('./routes/bookings.routes');
const adminRouter = require('./routes/admin.routes');

const app = express();
const PORT = Number(process.env.PORT || 3000);

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT trong .env phải là số nguyên từ 1 đến 65535.');
}

// Chi nhan JSON nho, khong nhan noi dung nen.
app.use(express.json({ limit: '16kb', inflate: false }));

// API kiem tra Backend.
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    application: 'train-ticket',
    version: '1.1',
    message: 'Backend Express đang chạy.'
  });
});

// API lay danh sach ga va tim kiem theo tu khoa.
app.get('/api/stations', async (req, res) => {
  const rawKeyword = req.query.keyword ?? '';

  if (typeof rawKeyword !== 'string' || rawKeyword.length > 100) {
    return res.status(400).json({
      ok: false,
      message: 'Từ khóa phải là chuỗi tối đa 100 ký tự.'
    });
  }

  const keyword = rawKeyword.trim();

  try {
    const pool = await getPool();

    const result = await pool.request()
      .input('keyword', sql.NVarChar(100), keyword)
      .query(`
        SELECT id, code, name, city
        FROM dbo.Stations
        WHERE is_active = 1
          AND (
            @keyword = N''
            OR code LIKE N'%' + @keyword + N'%'
            OR name LIKE N'%' + @keyword + N'%'
            OR city LIKE N'%' + @keyword + N'%'
          )
        ORDER BY id;
      `);

    res.json({
      ok: true,
      total: result.recordset.length,
      items: result.recordset
    });
  } catch (error) {
    console.error('Lỗi đọc danh sách ga:', error.code || 'UNKNOWN');

    res.status(500).json({
      ok: false,
      message: 'Không tải được danh sách ga. Vui lòng thử lại sau.'
    });
  }
});

// Gan cac router API truoc phan phuc vu giao dien va xu ly 404.
app.use('/api/trips', tripsRouter);
app.use('/api/auth', authRouter);
app.use('/api/bookings', bookingsRouter);
app.use('/api/admin', adminRouter);

// Phuc vu HTML, CSS va JavaScript trong thu muc frontend.
const frontendPath = path.resolve(__dirname, '../../frontend');
app.use(express.static(frontendPath));

// Dat xu ly 404 sau cac route va express.static.
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    message: 'Không tìm thấy đường dẫn.'
  });
});

// Xu ly loi JSON va loi chua duoc bat. Khong tra lai noi dung mat khau.
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  res.set('Cache-Control', 'no-store');

  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({
      ok: false,
      message: 'Dữ liệu JSON không hợp lệ.'
    });
  }

  if (error.type === 'entity.too.large') {
    return res.status(413).json({
      ok: false,
      message: 'Dữ liệu gửi lên vượt quá giới hạn cho phép.'
    });
  }

  if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
    return res.status(error.status).json({
      ok: false,
      message: error.code === 'INVALID_INPUT' ? error.message : 'Yêu cầu không hợp lệ.'
    });
  }

  console.error('Lỗi xử lý yêu cầu:', error.code || 'UNKNOWN');
  res.status(500).json({
    ok: false,
    message: 'Không thể xử lý yêu cầu lúc này. Vui lòng thử lại sau.'
  });
});

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Mở giao diện tại http://localhost:${PORT}`);
  console.log(`Kiểm tra API tại http://localhost:${PORT}/api/health`);
  console.log(`Danh sách ga tại http://localhost:${PORT}/api/stations`);
  console.log(`Tìm chuyến tại http://localhost:${PORT}/api/trips`);
  console.log(`Đăng ký bằng POST tại http://localhost:${PORT}/api/auth/register`);
  console.log(`Trang quản trị http://localhost:${PORT}/admin.html`);
});

server.on('error', (error) => {
  console.error('Không khởi động được server:', error.message);
  process.exitCode = 1;
});

if (process.env.BOOKING_SWEEP !== 'false') {
  let sweeping = false;
  const timer = setInterval(async () => {
    if (!server.listening || sweeping) return;
    sweeping = true;
    try {
      const pool = await getPool();
      await pool.request().execute('dbo.ExpireBookingHolds');
    } catch (error) {
      console.error('Lỗi trả chỗ hết hạn:', error.code || 'UNKNOWN', error.number ?? '');
    } finally {
      sweeping = false;
    }
  }, 60000);
  timer.unref();
  server.once('close', () => clearInterval(timer));
}

module.exports = server;
