const { createHash } = require('node:crypto');
const express = require('express');
const { sql, getPool } = require('../config/db');

const router = express.Router();

// 1. Kiem tra ID va tham so phan trang.
function readInteger(value, name, fallback, max = 2147483647) {
  if (value === undefined) return fallback;

  const number = Number(value);
  if (
    typeof value !== 'string' || !/^[1-9]\d*$/.test(value)
    || !Number.isSafeInteger(number) || number > max
  ) {
    throw new Error(`${name} phải là số nguyên từ 1 đến ${max}.`);
  }

  return number;
}

// 2. Doi ngay Viet Nam thanh khoang thoi gian UTC.
function readDateRange(value) {
  if (value === undefined) return { from: null, to: null };

  const message = 'date phải là ngày hợp lệ, định dạng YYYY-MM-DD.';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(message);
  }

  const midnight = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(midnight.getTime())
    || midnight.getUTCFullYear() < 1900
    || midnight.getUTCFullYear() > 9998
    || midnight.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(message);
  }

  const from = new Date(midnight.getTime() - 7 * 60 * 60 * 1000);
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  return { from, to };
}

// 3. Dung chung dieu kien cho dem tong va lay tung trang.
const fromSql = `
  FROM dbo.Trips AS trip
  INNER JOIN dbo.Trains AS train ON train.id = trip.train_id
  INNER JOIN dbo.Stations AS origin ON origin.id = trip.origin_id
  INNER JOIN dbo.Stations AS destination
    ON destination.id = trip.destination_id
`;

const openTripWhereSql = `
  WHERE trip.status = 'OPEN'
    AND trip.departure_at > @now
    AND train.is_active = 1
    AND origin.is_active = 1
    AND destination.is_active = 1
`;

const whereSql = `
  ${openTripWhereSql}
    AND (@origin_id IS NULL OR trip.origin_id = @origin_id)
    AND (@destination_id IS NULL OR trip.destination_id = @destination_id)
    AND (
      @date_from IS NULL
      OR (trip.departure_at >= @date_from AND trip.departure_at < @date_to)
    )
`;

const availableSeatSql = `(
  trip_seat.state = 'AVAILABLE'
  OR (trip_seat.state = 'HELD' AND trip_seat.hold_expires_at <= @now)
)`;

// 4. GET /api/trips
router.get('/', async (req, res) => {
  let originId, destinationId, page, pageSize, dateRange;

  try {
    originId = readInteger(req.query.origin_id, 'origin_id', null);
    destinationId = readInteger(req.query.destination_id, 'destination_id', null);
    page = readInteger(req.query.page, 'page', 1, 100000);
    pageSize = readInteger(req.query.page_size, 'page_size', 10, 50);
    dateRange = readDateRange(req.query.date);

    if (originId !== null && originId === destinationId) {
      throw new Error('Ga đi và ga đến phải khác nhau.');
    }
  } catch (error) {
    return res.status(400).json({ ok: false, message: error.message });
  }

  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('origin_id', sql.Int, originId)
      .input('destination_id', sql.Int, destinationId)
      .input('date_from', sql.DateTime2, dateRange.from)
      .input('date_to', sql.DateTime2, dateRange.to)
      .input('offset', sql.Int, (page - 1) * pageSize)
      .input('page_size', sql.Int, pageSize)
      .query(`
        DECLARE @now DATETIME2 = SYSUTCDATETIME();

        SELECT COUNT(*) AS total
        ${fromSql}
        ${whereSql};

        SELECT
          trip.id, trip.code,
          train.code AS train_code,
          origin.id AS origin_id,
          origin.code AS origin_code,
          origin.name AS origin_name,
          destination.id AS destination_id,
          destination.code AS destination_code,
          destination.name AS destination_name,
          trip.departure_at, trip.arrival_at,
          stock.available_seats, stock.min_price
        ${fromSql}
        OUTER APPLY (
          SELECT
            COUNT(*) AS available_seats,
            MIN(trip_seat.price) AS min_price
          FROM dbo.TripSeats AS trip_seat
          INNER JOIN dbo.Seats AS seat ON seat.id = trip_seat.seat_id
          INNER JOIN dbo.Carriages AS carriage ON carriage.id = seat.carriage_id
          WHERE trip_seat.trip_id = trip.id
            AND ${availableSeatSql}
            AND seat.is_active = 1
            AND carriage.is_active = 1
            AND carriage.train_id = trip.train_id
        ) AS stock
        ${whereSql}
        ORDER BY trip.departure_at, trip.id
        OFFSET @offset ROWS FETCH NEXT @page_size ROWS ONLY;
      `);

    const total = result.recordsets[0][0].total;
    res.json({
      ok: true,
      page,
      page_size: pageSize,
      total,
      total_pages: Math.ceil(total / pageSize),
      items: result.recordsets[1]
    });
  } catch (error) {
    console.error('Lỗi tìm chuyến:', error.code || 'UNKNOWN');
    res.status(500).json({
      ok: false,
      message: 'Không tải được danh sách chuyến. Vui lòng thử lại.'
    });
  }
});

// 5. GET /api/trips/:tripId/seats
router.get('/:tripId/seats', async (req, res) => {
  res.set('Cache-Control', 'no-store');

  let tripId;
  try {
    tripId = readInteger(req.params.tripId, 'tripId', null);
  } catch (error) {
    return res.status(400).json({ ok: false, message: error.message });
  }

  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('trip_id', sql.Int, tripId)
      .query(`
        DECLARE @now DATETIME2 = SYSUTCDATETIME();

        SELECT
          trip.id, trip.code,
          train.code AS train_code,
          origin.name AS origin_name,
          destination.name AS destination_name,
          trip.departure_at, trip.arrival_at,
          inventory.carriage_id, inventory.carriage_number, inventory.carriage_type,
          inventory.trip_seat_id, inventory.seat_number, inventory.price, inventory.state
        ${fromSql}
        OUTER APPLY (
          SELECT
            carriage.id AS carriage_id,
            carriage.carriage_number, carriage.carriage_type,
            trip_seat.id AS trip_seat_id,
            seat.seat_number, trip_seat.price,
            CASE WHEN ${availableSeatSql} THEN 'AVAILABLE' ELSE trip_seat.state END AS state
          FROM dbo.TripSeats AS trip_seat
          INNER JOIN dbo.Seats AS seat ON seat.id = trip_seat.seat_id
          INNER JOIN dbo.Carriages AS carriage ON carriage.id = seat.carriage_id
          WHERE trip_seat.trip_id = trip.id
            AND seat.is_active = 1
            AND carriage.is_active = 1
            AND carriage.train_id = trip.train_id
        ) AS inventory
        ${openTripWhereSql}
          AND trip.id = @trip_id
        ORDER BY inventory.carriage_number, inventory.seat_number;
      `);

    const rows = result.recordset;
    const first = rows[0];
    if (!first) {
      return res.status(404).json({
        ok: false,
        message: 'Không tìm thấy chuyến tàu đang mở bán.'
      });
    }

    const carriages = new Map();
    for (const row of rows) {
      if (row.trip_seat_id === null) continue;

      if (!carriages.has(row.carriage_id)) {
        carriages.set(row.carriage_id, {
          id: row.carriage_id,
          carriage_number: row.carriage_number,
          carriage_type: row.carriage_type,
          seats: []
        });
      }

      carriages.get(row.carriage_id).seats.push({
        id: row.trip_seat_id,
        seat_number: row.seat_number,
        price: row.price,
        state: row.state
      });
    }

    res.json({
      ok: true,
      trip: {
        id: first.id,
        code: first.code,
        train_code: first.train_code,
        origin_name: first.origin_name,
        destination_name: first.destination_name,
        departure_at: first.departure_at,
        arrival_at: first.arrival_at
      },
      carriages: [...carriages.values()]
    });
  } catch (error) {
    console.error('Lỗi xem ghế theo chuyến:', error.code || 'UNKNOWN');
    res.status(500).json({
      ok: false,
      message: 'Không tải được danh sách ghế. Vui lòng thử lại.'
    });
  }
});

// 6. Doc phien va du lieu gui khi tao don giu cho.
function readBookingSession(req) {
  const prefix = 'train_session=';
  const cookies = (req.get('Cookie') ?? '').split(';')
    .map(part => part.trim())
    .filter(part => part.startsWith(prefix));

  if (cookies.length !== 1) return null;
  const token = cookies[0].slice(prefix.length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return createHash('sha256').update(token).digest();
}

function readBookingItems(body) {
  const { idempotency_key: key, items } = body ?? {};

  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(key)) {
    throw new Error('Mã yêu cầu đặt chỗ không hợp lệ.');
  }

  if (!Array.isArray(items) || items.length < 1 || items.length > 6) {
    throw new Error('Mỗi đơn phải có từ 1 đến 6 chỗ.');
  }

  const seatIds = new Set();
  const passengers = items.map(item => {
    const seatId = item?.trip_seat_id;
    const name = typeof item?.passenger_name === 'string' ? item.passenger_name.trim() : '';

    if (!Number.isInteger(seatId) || seatId < 1 || seatId > 2147483647) {
      throw new Error('Mã chỗ không hợp lệ.');
    }

    if (seatIds.has(seatId)) throw new Error('Mỗi chỗ chỉ được chọn một lần.');

    if (name.length < 2 || name.length > 100 || !name.isWellFormed()
        || /[\u0000-\u001f\u007f]/u.test(name)) {
      throw new Error('Họ tên hành khách phải từ 2 đến 100 ký tự hợp lệ.');
    }

    seatIds.add(seatId);
    return { trip_seat_id: seatId, passenger_name: name };
  });

  return { key, passengers };
}

const bookingErrors = new Map([
  [51001, [400, 'INVALID_BOOKING', 'Thông tin giữ chỗ không hợp lệ.']],
  [51002, [401, 'SESSION_REQUIRED', 'Bạn cần đăng nhập lại để giữ chỗ.']],
  [51003, [404, 'TRIP_UNAVAILABLE', 'Chuyến tàu không còn mở bán.']],
  [51004, [409, 'SEATS_UNAVAILABLE', 'Một số chỗ không còn trống. Vui lòng chọn lại.']],
  [51005, [409, 'REQUEST_CONFLICT', 'Mã yêu cầu đã được dùng với thông tin khác.']],
  [51006, [503, 'BOOKING_BUSY', 'Hệ thống đang xử lý giữ chỗ. Vui lòng thử lại.']]
]);

function bookingSessionRequired(res) {
  return res.status(401).json({
    ok: false,
    code: 'SESSION_REQUIRED',
    message: 'Bạn cần đăng nhập để giữ chỗ.'
  });
}

// 7. POST /api/trips/:tripId/bookings
router.post('/:tripId/bookings', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const tokenHash = readBookingSession(req);
  if (!tokenHash) return bookingSessionRequired(res);

  if (!req.is('application/json')) {
    return res.status(415).json({
      ok: false,
      message: 'Yêu cầu giữ chỗ phải gửi dữ liệu JSON.'
    });
  }

  let tripId, input;
  try {
    tripId = readInteger(req.params.tripId, 'tripId', null);
    input = readBookingItems(req.body);
  } catch (error) {
    return res.status(400).json({
      ok: false,
      code: 'INVALID_BOOKING',
      message: error.message
    });
  }

  try {
    const pool = await getPool();
    const session = await pool.request()
      .input('token_hash', sql.VarBinary(32), tokenHash)
      .query(`
        SELECT u.id, u.[role]
        FROM dbo.UserSessions AS s
        INNER JOIN dbo.Users AS u ON u.id = s.user_id
        WHERE s.token_hash = @token_hash AND s.expires_at > SYSUTCDATETIME()
          AND u.is_active = 1;
      `);

    const user = session.recordset[0];
    if (!user) return bookingSessionRequired(res);

    if (user.role !== 'CUSTOMER') {
      return res.status(403).json({
        ok: false,
        message: 'Chỉ tài khoản khách hàng được giữ chỗ.'
      });
    }

    const result = await pool.request()
      .input('user_id', sql.Int, user.id)
      .input('trip_id', sql.Int, tripId)
      .input('idempotency_key', sql.VarChar(64), input.key)
      .input('items_json', sql.NVarChar(sql.MAX), JSON.stringify(input.passengers))
      .execute('dbo.CreateBookingHold');

    const row = result.recordset[0];
    if (!row) throw new Error('Missing booking result');
    const isReplay = row.is_replay === true || row.is_replay === 1;

    res.status(isReplay ? 200 : 201).json({
      ok: true,
      is_replay: isReplay,
      booking: {
        id: row.id,
        code: row.code,
        trip_id: row.trip_id,
        status: row.status,
        total_amount: row.total_amount,
        expires_at: row.expires_at
      }
    });
  } catch (error) {
    const number = error.number ?? error.originalError?.info?.number;
    const mapped = bookingErrors.get(number === 1205 ? 51006 : number);

    if (mapped) {
      const [status, code, message] = mapped;
      if (status === 503) res.set('Retry-After', '1');
      return res.status(status).json({ ok: false, code, message });
    }

    console.error('Lỗi giữ chỗ:', error.code || 'UNKNOWN', number ?? '');
    res.status(500).json({
      ok: false,
      message: 'Không giữ được chỗ. Vui lòng thử lại.'
    });
  }
});

module.exports = router;