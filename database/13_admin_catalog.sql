USE TrainTicketDB;
GO

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

CREATE OR ALTER PROCEDURE dbo.AdminCreateTrain
    @code VARCHAR(10),
    @name NVARCHAR(100),
    @is_active BIT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    BEGIN TRY
        BEGIN TRANSACTION;
        INSERT INTO dbo.Trains (code, name, is_active) VALUES (@code, @name, @is_active);
        DECLARE @train_id INT = CONVERT(INT, SCOPE_IDENTITY());

        INSERT INTO dbo.Carriages (train_id, carriage_number, carriage_type)
        VALUES (@train_id, 1, 'SOFT_SEAT'), (@train_id, 2, 'SLEEPER');

        INSERT INTO dbo.Seats (carriage_id, seat_number)
        SELECT carriage.id, seat.number
        FROM dbo.Carriages AS carriage
        CROSS JOIN (VALUES (1), (2), (3), (4), (5), (6), (7), (8), (9), (10), (11), (12)) AS seat(number)
        WHERE carriage.train_id = @train_id;

        COMMIT TRANSACTION;
        SELECT @train_id AS id;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
        THROW;
    END CATCH;
END;
GO

CREATE OR ALTER PROCEDURE dbo.AdminDeleteTrain
    @train_id INT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    BEGIN TRY
        BEGIN TRANSACTION;
        IF NOT EXISTS (SELECT 1 FROM dbo.Trains WITH (XLOCK, HOLDLOCK) WHERE id = @train_id)
            THROW 51302, N'Không tìm thấy đoàn tàu.', 1;
        IF EXISTS (SELECT 1 FROM dbo.Trips WHERE train_id = @train_id)
            THROW 51303, N'Đoàn tàu đã được chuyến tham chiếu.', 1;

        DELETE seat FROM dbo.Seats AS seat
        INNER JOIN dbo.Carriages AS carriage ON carriage.id = seat.carriage_id
        WHERE carriage.train_id = @train_id;
        DELETE FROM dbo.Carriages WHERE train_id = @train_id;
        DELETE FROM dbo.Trains WHERE id = @train_id;
        COMMIT TRANSACTION;
        SELECT @train_id AS id;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
        THROW;
    END CATCH;
END;
GO

CREATE OR ALTER PROCEDURE dbo.AdminWriteTrip
    @operation VARCHAR(6),
    @trip_id INT = NULL,
    @code VARCHAR(30) = NULL,
    @train_id INT = NULL,
    @origin_id INT = NULL,
    @destination_id INT = NULL,
    @departure_at DATETIME2 = NULL,
    @arrival_at DATETIME2 = NULL,
    @base_price DECIMAL(12,0) = NULL,
    @status VARCHAR(20) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    IF @operation IS NULL OR @operation NOT IN ('SAVE', 'DELETE') OR (@operation = 'DELETE' AND @trip_id IS NULL)
        THROW 51301, N'Thao tác chuyến không hợp lệ.', 1;

    DECLARE @lock_result INT, @trip_lock NVARCHAR(255);
    BEGIN TRY
        BEGIN TRANSACTION;
        IF @trip_id IS NOT NULL
        BEGIN
            SET @trip_lock = CONCAT(N'TrainTicket:Trip:', @trip_id);
            EXEC @lock_result = sys.sp_getapplock
                @Resource = @trip_lock, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 3000;
            IF @lock_result < 0
                THROW 51304, N'Chuyến đang có giao dịch khác. Vui lòng thử lại.', 1;

            IF NOT EXISTS (SELECT 1 FROM dbo.Trips WITH (UPDLOCK) WHERE id = @trip_id)
                THROW 51302, N'Không tìm thấy chuyến tàu.', 1;
            IF EXISTS (SELECT 1 FROM dbo.Bookings WHERE trip_id = @trip_id)
                THROW 51303, N'Chuyến đã có lịch sử đặt vé.', 1;

            DELETE FROM dbo.TripSeats WHERE trip_id = @trip_id;
        END;

        IF @operation = 'DELETE'
            DELETE FROM dbo.Trips WHERE id = @trip_id;
        ELSE
        BEGIN
            IF @departure_at IS NULL OR @arrival_at IS NULL OR @departure_at >= @arrival_at
                OR @origin_id = @destination_id OR @status IS NULL OR @status NOT IN ('OPEN','CLOSED','CANCELLED')
                OR (@status = 'OPEN' AND @departure_at <= SYSUTCDATETIME())
                OR @base_price IS NULL OR @base_price < 0 OR @base_price > 1000000000
                THROW 51301, N'Kiểm tra hành trình, thời gian, trạng thái và giá vé.', 1;
            IF NOT EXISTS (SELECT 1 FROM dbo.Trains WHERE id = @train_id AND is_active = 1)
                OR (SELECT COUNT(*) FROM dbo.Stations WHERE id IN (@origin_id, @destination_id) AND is_active = 1) <> 2
                THROW 51301, N'Hãy chọn đoàn tàu và hai ga đang hoạt động.', 1;

            IF @trip_id IS NULL
            BEGIN
                INSERT INTO dbo.Trips (code, train_id, origin_id, destination_id, departure_at, arrival_at, base_price, status)
                VALUES (@code, @train_id, @origin_id, @destination_id, @departure_at, @arrival_at, @base_price, @status);
                SET @trip_id = CONVERT(INT, SCOPE_IDENTITY());
            END
            ELSE
                UPDATE dbo.Trips SET code = @code, train_id = @train_id, origin_id = @origin_id,
                    destination_id = @destination_id, departure_at = @departure_at,
                    arrival_at = @arrival_at, base_price = @base_price, status = @status
                WHERE id = @trip_id;

            INSERT INTO dbo.TripSeats (trip_id, seat_id, price)
            SELECT @trip_id, seat.id,
                CAST(CASE WHEN carriage.carriage_type = 'SLEEPER' THEN @base_price * 1.5 ELSE @base_price END AS DECIMAL(12,0))
            FROM dbo.Carriages AS carriage
            INNER JOIN dbo.Seats AS seat ON seat.carriage_id = carriage.id AND seat.is_active = 1
            WHERE carriage.train_id = @train_id AND carriage.is_active = 1;
            IF @@ROWCOUNT = 0
                THROW 51301, N'Đoàn tàu không có chỗ đang hoạt động.', 1;
        END;

        COMMIT TRANSACTION;
        SELECT @trip_id AS id;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
        THROW;
    END CATCH;
END;
GO

IF USER_ID(N'train_app') IS NOT NULL
BEGIN
    GRANT EXECUTE ON OBJECT::dbo.AdminCreateTrain TO [train_app];
    GRANT EXECUTE ON OBJECT::dbo.AdminDeleteTrain TO [train_app];
    GRANT EXECUTE ON OBJECT::dbo.AdminWriteTrip TO [train_app];
END;
GO
