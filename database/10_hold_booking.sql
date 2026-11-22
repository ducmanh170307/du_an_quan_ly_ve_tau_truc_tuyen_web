-- FILE 10: TAO DON VA GIU CHO TRONG CUNG GIAO DICH
-- Chay sau 09_bookings.sql. Moi don co tu 1 den 6 cho.
USE TrainTicketDB;
GO

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

CREATE OR ALTER PROCEDURE dbo.CreateBookingHold
    @user_id INT,
    @trip_id INT,
    @idempotency_key VARCHAR(256),
    @items_json NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    SET ANSI_PADDING ON;
    SET ANSI_WARNINGS ON;
    SET ARITHABORT ON;
    SET CONCAT_NULL_YIELDS_NULL ON;
    SET NUMERIC_ROUNDABORT OFF;

    IF @user_id IS NULL OR @user_id < 1 OR @trip_id IS NULL OR @trip_id < 1
        THROW 51001, N'Tài khoản hoặc chuyến tàu không hợp lệ.', 1;

    IF @idempotency_key IS NULL OR DATALENGTH(@idempotency_key) NOT BETWEEN 1 AND 64
       OR @idempotency_key COLLATE Latin1_General_100_BIN2 LIKE '%[^0-9A-Za-z_-]%'
        THROW 51001, N'Mã yêu cầu đặt chỗ không hợp lệ.', 1;

    IF @items_json IS NULL OR DATALENGTH(@items_json) > 12000
       OR ISJSON(@items_json, ARRAY) <> 1
        THROW 51001, N'Danh sách hành khách phải là một mảng JSON hợp lệ.', 1;

    DECLARE @requested TABLE (
        trip_seat_id INT NULL,
        passenger_name NVARCHAR(4000) NULL
    );

    INSERT INTO @requested (trip_seat_id, passenger_name)
    SELECT TRY_CONVERT(INT, item.seat_id), LTRIM(RTRIM(item.passenger_name))
    FROM OPENJSON(@items_json) WITH (
        seat_id NVARCHAR(100) '$.trip_seat_id',
        passenger_name NVARCHAR(4000) '$.passenger_name'
    ) AS item;

    DECLARE @seat_count INT = @@ROWCOUNT;

    IF @seat_count NOT BETWEEN 1 AND 6
        THROW 51001, N'Mỗi đơn phải có từ 1 đến 6 chỗ.', 1;

    IF EXISTS (
        SELECT 1 FROM @requested
        WHERE trip_seat_id IS NULL OR trip_seat_id < 1 OR passenger_name IS NULL
          OR DATALENGTH(passenger_name) NOT BETWEEN 4 AND 200
    )
        THROW 51001, N'Số chỗ hoặc họ tên hành khách không hợp lệ.', 1;

    IF EXISTS (
        SELECT 1 FROM @requested GROUP BY trip_seat_id HAVING COUNT(*) > 1
    )
        THROW 51001, N'Mỗi chỗ chỉ được chọn một lần trong đơn.', 1;

    DECLARE @booking_id INT, @existing_trip_id INT, @train_id INT;
    DECLARE @now DATETIME2, @departure_at DATETIME2, @expires_at DATETIME2;
    DECLARE @is_replay BIT = 0, @lock_result INT;
    DECLARE @request_lock NVARCHAR(255) = CONCAT(N'TrainTicket:Request:', @user_id, N':', @idempotency_key);
    DECLARE @trip_lock NVARCHAR(255) = CONCAT(N'TrainTicket:Trip:', @trip_id);
    DECLARE @expired TABLE (booking_id INT PRIMARY KEY);
    DECLARE @held TABLE (trip_seat_id INT PRIMARY KEY, price DECIMAL(12, 0) NOT NULL);
    DECLARE @inserted TABLE (booking_id INT PRIMARY KEY);

    BEGIN TRY
        BEGIN TRANSACTION;

        -- Khoa cung ma yeu cau ke ca khi no duoc gui cho hai chuyen.
        EXEC @lock_result = sys.sp_getapplock
            @Resource = @request_lock, @LockMode = 'Exclusive',
            @LockOwner = 'Transaction', @LockTimeout = 5000;
        IF @lock_result < 0
            THROW 51006, N'Yêu cầu đang được xử lý. Vui lòng thử lại.', 1;

        IF NOT EXISTS (SELECT 1 FROM dbo.Users WHERE id = @user_id AND is_active = 1)
            THROW 51002, N'Tài khoản không còn hoạt động.', 1;

        SELECT @booking_id = id, @existing_trip_id = trip_id
        FROM dbo.Bookings
        WHERE user_id = @user_id AND idempotency_key = @idempotency_key;

        IF @booking_id IS NOT NULL AND @existing_trip_id <> @trip_id
            THROW 51005, N'Mã yêu cầu đã được dùng cho một đơn khác.', 1;

        -- Cac thao tac giu cho cua cung chuyen duoc xu ly lan luot.
        EXEC @lock_result = sys.sp_getapplock
            @Resource = @trip_lock, @LockMode = 'Exclusive',
            @LockOwner = 'Transaction', @LockTimeout = 5000;
        IF @lock_result < 0
            THROW 51006, N'Chuyến đang có giao dịch khác. Vui lòng thử lại.', 1;

        SET @now = SYSUTCDATETIME();

        -- Thu hoi cho tu cac don da het han cua chuyen nay.
        UPDATE dbo.Bookings
        SET status = 'EXPIRED', updated_at = @now
        OUTPUT INSERTED.id INTO @expired (booking_id)
        WHERE trip_id = @trip_id AND status = 'PENDING_PAYMENT' AND expires_at <= @now;

        UPDATE ts
        SET state = 'AVAILABLE', booking_id = NULL, hold_expires_at = NULL
        FROM dbo.TripSeats AS ts
        INNER JOIN @expired AS expired ON expired.booking_id = ts.booking_id
        WHERE ts.state = 'HELD';

        UPDATE item
        SET status = 'EXPIRED'
        FROM dbo.BookingItems AS item
        INNER JOIN @expired AS expired ON expired.booking_id = item.booking_id
        WHERE item.status = 'HELD';

        IF @booking_id IS NOT NULL
        BEGIN
            IF @seat_count <> (SELECT COUNT(*) FROM dbo.BookingItems WHERE booking_id = @booking_id)
               OR EXISTS (
                    SELECT trip_seat_id, passenger_name COLLATE Latin1_General_100_BIN2 FROM @requested
                    EXCEPT
                    SELECT trip_seat_id, passenger_name COLLATE Latin1_General_100_BIN2
                    FROM dbo.BookingItems WHERE booking_id = @booking_id
                )
                THROW 51005, N'Mã yêu cầu đã được dùng với thông tin đặt chỗ khác.', 1;

            SET @is_replay = 1;
        END
        ELSE
        BEGIN
            SELECT @train_id = trip.train_id, @departure_at = trip.departure_at
            FROM dbo.Trips AS trip WITH (UPDLOCK)
            INNER JOIN dbo.Trains AS train ON train.id = trip.train_id AND train.is_active = 1
            INNER JOIN dbo.Stations AS origin ON origin.id = trip.origin_id AND origin.is_active = 1
            INNER JOIN dbo.Stations AS destination ON destination.id = trip.destination_id AND destination.is_active = 1
            WHERE trip.id = @trip_id AND trip.status = 'OPEN' AND trip.departure_at > @now;

            IF @departure_at IS NULL
                THROW 51003, N'Chuyến tàu không còn mở bán.', 1;

            SET @expires_at = DATEADD(MINUTE, 5, @now);
            IF @departure_at < @expires_at SET @expires_at = @departure_at;

            INSERT INTO dbo.Bookings (
                code, user_id, trip_id, total_amount, expires_at, idempotency_key, created_at, updated_at
            )
            OUTPUT INSERTED.id INTO @inserted (booking_id)
            VALUES (
                REPLACE(CONVERT(VARCHAR(36), NEWID()), '-', ''),
                @user_id, @trip_id, 0, @expires_at, @idempotency_key, @now, @now
            );
            SELECT @booking_id = booking_id FROM @inserted;

            -- Kiem tra con trong ngay trong lenh cap nhat va lay gia CSDL.
            UPDATE ts
            SET state = 'HELD', booking_id = @booking_id, hold_expires_at = @expires_at
            OUTPUT INSERTED.id, INSERTED.price INTO @held (trip_seat_id, price)
            FROM dbo.TripSeats AS ts
            INNER JOIN @requested AS requested ON requested.trip_seat_id = ts.id
            INNER JOIN dbo.Seats AS seat ON seat.id = ts.seat_id AND seat.is_active = 1
            INNER JOIN dbo.Carriages AS carriage
                ON carriage.id = seat.carriage_id AND carriage.is_active = 1
            WHERE ts.trip_id = @trip_id AND ts.state = 'AVAILABLE'
              AND carriage.train_id = @train_id;

            IF @@ROWCOUNT <> @seat_count
                THROW 51004, N'Một số chỗ đã hết hoặc không thuộc chuyến. Vui lòng chọn lại.', 1;

            INSERT INTO dbo.BookingItems (
                booking_id, trip_id, trip_seat_id, passenger_name, price_snapshot
            )
            SELECT @booking_id, @trip_id, held.trip_seat_id, requested.passenger_name, held.price
            FROM @held AS held
            INNER JOIN @requested AS requested ON requested.trip_seat_id = held.trip_seat_id;

            UPDATE dbo.Bookings
            SET total_amount = (SELECT SUM(price) FROM @held)
            WHERE id = @booking_id;
        END;

        COMMIT TRANSACTION;

        SELECT id, code, trip_id, status, total_amount, expires_at, @is_replay AS is_replay
        FROM dbo.Bookings WHERE id = @booking_id;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
        THROW;
    END CATCH;
END;
GO

SELECT OBJECT_ID(N'dbo.CreateBookingHold', N'P') AS procedure_id;
GO