const express = require('express');
const { sql } = require('../config/db');
const { requireSession } = require('../utils/session');
const { invalid, positiveId, text, vietnamDate, vietnamDateTime, jsonBody } = require('../utils/validation');

const router = express.Router();
router.use(requireSession, (req, res, next) => {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ ok: false, message: 'Chức năng này dành cho quản trị viên.' });
  }
  next();
}, jsonBody);

const bookingStatus = `CASE WHEN b.status = 'PENDING_PAYMENT' AND b.expires_at <= @now
  THEN 'EXPIRED' ELSE b.status END`;
const tripStatuses = ['OPEN', 'CLOSED', 'CANCELLED'];
const bookingStatuses = ['PENDING_PAYMENT', 'PAID', 'CANCELLED', 'EXPIRED'];
const catalog = {
  stations: {
    select: 's.id, s.code, s.name, s.city, s.is_active',
    from: 'FROM dbo.Stations AS s',
    search: "s.code LIKE @keyword OR s.name LIKE @keyword OR s.city LIKE @keyword",
    sort: 's.code, s.id'
  },
  trains: {
    select: 't.id, t.code, t.name, t.is_active',
    from: 'FROM dbo.Trains AS t',
    search: 't.code LIKE @keyword OR t.name LIKE @keyword',
    sort: 't.code, t.id'
  },
  trips: {
    select: `t.id, t.code, t.train_id, t.origin_id, t.destination_id, t.departure_at, t.arrival_at,
      t.base_price, t.status, train.code AS train_code, origin.name AS origin_name, destination.name AS destination_name,
      CAST(CASE WHEN EXISTS (SELECT 1 FROM dbo.Bookings AS b WHERE b.trip_id = t.id) THEN 1 ELSE 0 END AS BIT) AS has_bookings`,
    from: `FROM dbo.Trips AS t
      INNER JOIN dbo.Trains AS train ON train.id = t.train_id
      INNER JOIN dbo.Stations AS origin ON origin.id = t.origin_id
      INNER JOIN dbo.Stations AS destination ON destination.id = t.destination_id`,
    search: 't.code LIKE @keyword OR train.code LIKE @keyword OR origin.name LIKE @keyword OR destination.name LIKE @keyword',
    status: 't.status', statuses: tripStatuses, date: 't.departure_at', sort: 't.departure_at DESC, t.id DESC'
  },
  bookings: {
    select: `b.id, b.code, ${bookingStatus} AS status, b.total_amount, b.created_at,
      t.code AS trip_code, u.full_name, u.email`,
    from: 'FROM dbo.Bookings AS b INNER JOIN dbo.Trips AS t ON t.id = b.trip_id INNER JOIN dbo.Users AS u ON u.id = b.user_id',
    search: 'b.code LIKE @keyword OR t.code LIKE @keyword OR u.email LIKE @keyword OR u.full_name LIKE @keyword',
    status: bookingStatus, statuses: bookingStatuses, date: 'b.created_at', sort: 'b.created_at DESC, b.id DESC'
  },
  users: {
    select: 'u.id, u.full_name, u.email, u.[role], u.is_active',
    from: 'FROM dbo.Users AS u',
    search: 'u.email LIKE @keyword OR u.full_name LIKE @keyword',
    sort: 'u.id DESC'
  }
};

function dateWindow(query) {
  const from = query.from === undefined ? null : vietnamDate(query.from, 'Ngày bắt đầu');
  const end = query.to === undefined ? null : vietnamDate(query.to, 'Ngày kết thúc');
  if (from && end && from > end) throw invalid('Ngày kết thúc phải từ ngày bắt đầu trở đi.');
  return { from, until: end ? new Date(+end + 86400000) : null };
}

function dateInputs(request, query) {
  const { from, until } = dateWindow(query);
  return request.input('from', sql.DateTime2, from).input('until', sql.DateTime2, until);
}

router.get('/catalog', async (req, res) => {
  const result = await req.db.request().query(`
    SELECT id, code, name FROM dbo.Stations WHERE is_active = 1 ORDER BY name, id;
    SELECT id, code, name FROM dbo.Trains WHERE is_active = 1 ORDER BY code, id;
  `);
  res.json({ ok: true, stations: result.recordsets[0], trains: result.recordsets[1] });
});

router.get('/statistics', async (req, res) => {
  const result = await dateInputs(req.db.request(), req.query).query(`
    DECLARE @now DATETIME2 = SYSUTCDATETIME();
    SELECT COUNT(*) AS total,
      COUNT(CASE WHEN b.status = 'PENDING_PAYMENT' AND b.expires_at > @now THEN 1 END) AS pending,
      COUNT(CASE WHEN b.status = 'PAID' THEN 1 END) AS paid,
      COUNT(CASE WHEN b.status = 'CANCELLED' THEN 1 END) AS cancelled,
      COUNT(CASE WHEN (${bookingStatus}) = 'EXPIRED' THEN 1 END) AS expired
    FROM dbo.Bookings AS b
    WHERE (@from IS NULL OR b.created_at >= @from) AND (@until IS NULL OR b.created_at < @until);

    SELECT COALESCE(SUM(amount), 0) AS revenue, COUNT(*) AS successful
    FROM dbo.Payments WHERE status = 'SUCCESS'
      AND (@from IS NULL OR paid_at >= @from) AND (@until IS NULL OR paid_at < @until);

    SELECT COUNT(*) AS tickets
    FROM dbo.BookingItems AS item
    INNER JOIN dbo.Bookings AS b ON b.id = item.booking_id AND b.status = 'PAID'
    INNER JOIN dbo.Payments AS p ON p.booking_id = b.id AND p.status = 'SUCCESS'
    WHERE item.status = 'ISSUED'
      AND (@from IS NULL OR p.paid_at >= @from) AND (@until IS NULL OR p.paid_at < @until);

    SELECT TOP (30) CONVERT(VARCHAR(10), DATEADD(HOUR, 7, paid_at), 23) AS day,
      COUNT(*) AS payments, SUM(amount) AS revenue
    FROM dbo.Payments
    WHERE status = 'SUCCESS' AND (@from IS NULL OR paid_at >= @from) AND (@until IS NULL OR paid_at < @until)
    GROUP BY CONVERT(VARCHAR(10), DATEADD(HOUR, 7, paid_at), 23)
    ORDER BY day DESC;
  `);
  const [orders, payments, issued, daily] = result.recordsets;
  res.json({ ok: true, ...orders[0], ...payments[0], ...issued[0], daily });
});

router.get('/:resource', async (req, res) => {
  const resource = req.params.resource;
  if (!Object.hasOwn(catalog, resource)) return res.status(404).json({ ok: false, message: 'Danh mục không tồn tại.' });
  const spec = catalog[resource];
  const page = positiveId(req.query.page ?? '1', 'Trang', 100000);
  const pageSize = 10;
  const keyword = text(req.query.keyword ?? '', 'Từ khóa', 100, true);
  const status = req.query.status ?? '';
  if (status !== '' && !spec.statuses?.includes(status)) throw invalid('Trạng thái không hợp lệ.');

  // Các đoạn SQL lấy từ danh sách catalog cố định. Giá trị do trình duyệt gửi đi qua tham số.
  const where = `WHERE (@keyword = N'' OR ${spec.search})
    ${spec.status ? `AND (@status = '' OR (${spec.status}) = @status)` : ''}
    ${spec.date ? `AND (@from IS NULL OR ${spec.date} >= @from)
      AND (@until IS NULL OR ${spec.date} < @until)` : ''}`;
  const request = dateInputs(req.db.request(), req.query)
    .input('keyword', sql.NVarChar(302), keyword ? '%' + keyword.replace(/[[%_]/g, c => '[' + c + ']') + '%' : '')
    .input('status', sql.VarChar(20), status)
    .input('offset', sql.Int, (page - 1) * pageSize)
    .input('page_size', sql.Int, pageSize);
  const result = await request.query(`
    DECLARE @now DATETIME2 = SYSUTCDATETIME();
    SELECT COUNT(*) AS total ${spec.from} ${where};
    SELECT ${spec.select} ${spec.from} ${where}
    ORDER BY ${spec.sort} OFFSET @offset ROWS FETCH NEXT @page_size ROWS ONLY;
  `);
  const total = result.recordsets[0][0].total;
  res.json({ ok: true, items: result.recordsets[1], page, total, total_pages: Math.ceil(total / pageSize) });
});

function codeInput(value, limit) {
  const code = text(value, 'Mã', limit);
  if (!/^[A-Za-z0-9_-]+$/.test(code)) throw invalid('Mã chỉ gồm chữ cái Latin, số, dấu gạch ngang và gạch dưới.');
  return code.toUpperCase();
}

function activeInput(value) {
  if (typeof value !== 'boolean') throw invalid('Trạng thái hoạt động không hợp lệ.');
  return value;
}

async function writeTrip(request, id, body, remove) {
  request.input('operation', sql.VarChar(6), remove ? 'DELETE' : 'SAVE')
    .input('trip_id', sql.Int, id);
  if (!remove) {
    const train = positiveId(body.train_id, 'Đoàn tàu');
    const origin = positiveId(body.origin_id, 'Ga đi');
    const destination = positiveId(body.destination_id, 'Ga đến');
    const departure = vietnamDateTime(body.departure_at, 'Giờ khởi hành');
    const arrival = vietnamDateTime(body.arrival_at, 'Giờ đến');
    if (origin === destination || departure >= arrival
        || !tripStatuses.includes(body.status) || (body.status === 'OPEN' && +departure <= Date.now())) {
      throw invalid('Kiểm tra hai ga, thời gian và trạng thái chuyến.');
    }
    if (!Number.isInteger(body.base_price) || body.base_price < 0 || body.base_price > 1000000000) {
      throw invalid('Giá vé cơ bản phải từ 0 đến 1.000.000.000 đ.');
    }
    request.input('code', sql.VarChar(30), codeInput(body.code, 30))
      .input('train_id', sql.Int, train)
      .input('origin_id', sql.Int, origin)
      .input('destination_id', sql.Int, destination)
      .input('departure_at', sql.DateTime2, departure)
      .input('arrival_at', sql.DateTime2, arrival)
      .input('base_price', sql.Decimal(12, 0), body.base_price)
      .input('status', sql.VarChar(20), body.status);
  }
  return request.execute('dbo.AdminWriteTrip');
}

const writeCatalog = {
  stations: {
    create: `INSERT INTO dbo.Stations (code, name, city, is_active)
      OUTPUT INSERTED.id VALUES (@code, @name, @city, @is_active);`,
    update: `UPDATE dbo.Stations SET code = @code, name = @name, city = @city, is_active = @is_active
      OUTPUT INSERTED.id WHERE id = @id;`,
    remove: 'DELETE FROM dbo.Stations OUTPUT DELETED.id WHERE id = @id;'
  },
  trains: {
    update: `UPDATE dbo.Trains SET code = @code, name = @name, is_active = @is_active
      OUTPUT INSERTED.id WHERE id = @id;`
  }
};

async function writeItem(req, res) {
  const { resource } = req.params;
  const remove = req.method === 'DELETE';
  const create = req.method === 'POST';
  const id = create ? null : positiveId(req.params.id, 'Mã bản ghi');
  const body = req.body ?? {};
  let result;
  const request = req.db.request();

  if (resource === 'trips') {
    result = await writeTrip(request, id, body, remove);
  } else if (Object.hasOwn(writeCatalog, resource)) {
    if (resource === 'trains' && remove) {
      result = await request.input('train_id', sql.Int, id).execute('dbo.AdminDeleteTrain');
    } else {
      if (id !== null) request.input('id', sql.Int, id);
      if (!remove) {
        request.input('code', sql.VarChar(10), codeInput(body.code, 10))
          .input('name', sql.NVarChar(100), text(body.name, 'Tên', 100))
          .input('is_active', sql.Bit, activeInput(body.is_active));
        if (resource === 'stations') request.input('city', sql.NVarChar(100), text(body.city, 'Thành phố', 100));
      }
      const query = writeCatalog[resource];
      result = resource === 'trains' && create
        ? await request.execute('dbo.AdminCreateTrain')
        : await request.query(remove ? query.remove : create ? query.create : query.update);
    }
  } else {
    return res.status(404).json({ ok: false, message: 'Danh mục không hỗ trợ thao tác này.' });
  }

  const row = result.recordset[0];
  if (!row) return res.status(404).json({ ok: false, message: 'Không tìm thấy bản ghi.' });
  res.status(create ? 201 : 200).json({ ok: true, id: row.id });
}

router.patch('/users/:id', async (req, res) => {
  const id = positiveId(req.params.id, 'Mã tài khoản');
  const active = activeInput(req.body?.is_active);
  const result = await req.db.request()
    .input('id', sql.Int, id)
    .input('active', sql.Bit, active)
    .query(`
      SET XACT_ABORT ON;
      BEGIN TRANSACTION;
      DECLARE @updated TABLE (id INT PRIMARY KEY);
      UPDATE dbo.Users SET is_active = @active, updated_at = SYSUTCDATETIME()
      OUTPUT INSERTED.id INTO @updated WHERE id = @id AND [role] = 'CUSTOMER';
      IF @active = 0
          DELETE session FROM dbo.UserSessions AS session INNER JOIN @updated AS u ON u.id = session.user_id;
      COMMIT TRANSACTION;
      SELECT id FROM @updated;
    `);
  if (!result.recordset.length) return res.status(404).json({ ok: false, message: 'Không tìm thấy tài khoản khách hàng.' });
  res.json({ ok: true, id });
});

router.post('/:resource', writeItem);
router.patch('/:resource/:id', writeItem);
router.delete('/:resource/:id', writeItem);

const sqlErrors = new Map([
  [2601, [409, 'Mã đã tồn tại.']],
  [2627, [409, 'Mã đã tồn tại.']],
  [547, [409, 'Dữ liệu đang được tham chiếu hoặc vi phạm ràng buộc.']],
  [51301, [400, 'Thông tin chuyến, đoàn tàu hoặc ga chưa hợp lệ. Kiểm tra giờ đi, giờ đến và trạng thái hoạt động.']],
  [51302, [404, 'Không tìm thấy bản ghi.']],
  [51303, [409, 'Đoàn tàu đã được tham chiếu hoặc chuyến đã có lịch sử đặt vé.']],
  [51304, [503, 'Dữ liệu đang có giao dịch khác. Vui lòng thử lại.']]
]);
router.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  if (error.status === 400) return res.status(400).json({ ok: false, message: error.message });
  const number = error.number ?? error.originalError?.info?.number;
  const mapped = sqlErrors.get(number === 1205 ? 51304 : number);
  if (!mapped) return next(error);
  const [status, message] = mapped;
  res.status(status).json({ ok: false, message });
});

module.exports = router;
