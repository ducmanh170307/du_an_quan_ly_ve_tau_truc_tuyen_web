-- FILE 6: TAO GIA VA TON CHO THEO TUNG CHUYEN
-- Chay sau cac file 01 den 05.
-- Gia mau: ghe mem = gia co ban; giuong nam = 1.5 lan gia co ban.

USE TrainTicketDB;
GO

-- 1. Tao bang cho cua tung chuyen.
IF OBJECT_ID(N'dbo.TripSeats', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.TripSeats (
        id INT IDENTITY(1, 1) NOT NULL
            CONSTRAINT PK_TripSeats PRIMARY KEY,
        trip_id INT NOT NULL,
        seat_id INT NOT NULL,
        price DECIMAL(12, 0) NOT NULL,
        state VARCHAR(20) NOT NULL
            CONSTRAINT DF_TripSeats_State DEFAULT ('AVAILABLE'),
        booking_id INT NULL,
        hold_expires_at DATETIME2 NULL,
        created_at DATETIME2 NOT NULL
            CONSTRAINT DF_TripSeats_CreatedAt DEFAULT (SYSUTCDATETIME()),

        CONSTRAINT FK_TripSeats_Trips
            FOREIGN KEY (trip_id) REFERENCES dbo.Trips(id),
        CONSTRAINT FK_TripSeats_Seats
            FOREIGN KEY (seat_id) REFERENCES dbo.Seats(id),
        CONSTRAINT UQ_TripSeats_Trip_Seat
            UNIQUE (trip_id, seat_id),
        CONSTRAINT CK_TripSeats_Price
            CHECK (price >= 0),
        CONSTRAINT CK_TripSeats_State
            CHECK (state IN ('AVAILABLE', 'HELD', 'BOOKED')),
        CONSTRAINT CK_TripSeats_Hold
            CHECK (
                (state = 'AVAILABLE'
                    AND booking_id IS NULL
                    AND hold_expires_at IS NULL)
                OR (state = 'HELD'
                    AND booking_id IS NOT NULL
                    AND hold_expires_at IS NOT NULL)
                OR (state = 'BOOKED'
                    AND booking_id IS NOT NULL
                    AND hold_expires_at IS NULL)
            )
    );
END;
GO

-- FK booking_id se duoc them sau khi tao bang Bookings.
-- hold_expires_at se luu thoi gian theo UTC.

-- 2. Tao cho cho cac chuyen OPEN chua khoi hanh.
-- Cac JOIN ben duoi chi lay cho thuoc dung doan tau cua chuyen.
INSERT INTO dbo.TripSeats (trip_id, seat_id, price)
SELECT
    trip.id,
    seat.id,
    CAST(
        CASE
            WHEN carriage.carriage_type = 'SLEEPER'
                THEN trip.base_price * 1.5
            ELSE trip.base_price
        END AS DECIMAL(12, 0)
    )
FROM dbo.Trips AS trip
INNER JOIN dbo.Trains AS train ON train.id = trip.train_id
INNER JOIN dbo.Carriages AS carriage ON carriage.train_id = train.id
INNER JOIN dbo.Seats AS seat ON seat.carriage_id = carriage.id
WHERE trip.status = 'OPEN'
  AND trip.departure_at > SYSUTCDATETIME()
  AND train.is_active = 1
  AND carriage.is_active = 1
  AND seat.is_active = 1
  AND NOT EXISTS (
      SELECT 1
      FROM dbo.TripSeats AS existing
      WHERE existing.trip_id = trip.id
        AND existing.seat_id = seat.id
  );
GO

-- 3. Kiem tra so cho va khoang gia cua tung chuyen.
SELECT
    trip.code,
    COUNT(trip_seat.id) AS total_seats,
    SUM(CASE WHEN trip_seat.state = 'AVAILABLE' THEN 1 ELSE 0 END)
        AS available_seats,
    SUM(CASE WHEN trip_seat.state = 'HELD' THEN 1 ELSE 0 END)
        AS held_seats,
    SUM(CASE WHEN trip_seat.state = 'BOOKED' THEN 1 ELSE 0 END)
        AS booked_seats,
    MIN(trip_seat.price) AS min_price,
    MAX(trip_seat.price) AS max_price
FROM dbo.Trips AS trip
LEFT JOIN dbo.TripSeats AS trip_seat ON trip_seat.trip_id = trip.id
GROUP BY trip.id, trip.code, trip.departure_at
ORDER BY trip.departure_at, trip.code;
GO

-- 4. Kiem tra tong so cho theo chuyen.
SELECT COUNT(*) AS total_trip_seats
FROM dbo.TripSeats;
GO