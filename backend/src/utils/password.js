const { randomBytes, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');

const scryptAsync = promisify(scrypt);

// 1. Thong so co dinh cho dinh dang scrypt-v1.
const PREFIX = 'scrypt-v1';
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const SCRYPT_V1 = Object.freeze({
  N: 131072,
  r: 8,
  p: 1,
  maxmem: 256 * 1024 * 1024
});

const MIN_PASSWORD_LENGTH = 15;
const MAX_PASSWORD_LENGTH = 128;
const ENCODED_LENGTH = PREFIX.length + 2 + SALT_BYTES * 2 + KEY_BYTES * 2;

// 2. Dem ky tu Unicode, giu nguyen noi dung mat khau.
function getPasswordLength(password) {
  if (
    typeof password !== 'string'
    || password.length > MAX_PASSWORD_LENGTH * 2
    || !password.isWellFormed()
  ) {
    return -1;
  }
  return Array.from(password).length;
}

// 3. Tao chuoi bam de luu vao Users.password_hash.
async function hashPassword(password) {
  const length = getPasswordLength(password);
  if (length < MIN_PASSWORD_LENGTH || length > MAX_PASSWORD_LENGTH) {
    const error = new Error('Mật khẩu phải từ 15 đến 128 ký tự.');
    error.code = 'PASSWORD_INVALID';
    throw error;
  }

  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(password, salt, KEY_BYTES, SCRYPT_V1);
  return [PREFIX, salt.toString('hex'), key.toString('hex')].join('$');
}

// 4. Kiem tra mat khau voi chuoi bam da luu.
async function verifyPassword(password, storedHash) {
  const length = getPasswordLength(password);
  if (length < 1 || length > MAX_PASSWORD_LENGTH) return false;
  if (typeof storedHash !== 'string' || storedHash.length !== ENCODED_LENGTH) {
    return false;
  }

  const parts = storedHash.split('$');
  if (
    parts.length !== 3 || parts[0] !== PREFIX
    || !/^[0-9a-f]{32}$/.test(parts[1])
    || !/^[0-9a-f]{128}$/.test(parts[2])
  ) {
    return false;
  }

  const salt = Buffer.from(parts[1], 'hex');
  const expectedKey = Buffer.from(parts[2], 'hex');
  const actualKey = await scryptAsync(password, salt, KEY_BYTES, SCRYPT_V1);
  return timingSafeEqual(expectedKey, actualKey);
}

module.exports = {
  hashPassword,
  verifyPassword,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH
};

// 5. Tu kiem tra khi chay: node src/utils/password.js.
if (require.main === module) {
  (async () => {
    const assert = require('node:assert/strict');
    const samplePassword = 'Mat khau thu nghiem 2026!';
    const storedHash = await hashPassword(samplePassword);
    const correct = await verifyPassword(samplePassword, storedHash);
    const incorrect = await verifyPassword('Mat khau nhap sai 2026!', storedHash);

    assert.equal(correct, true);
    assert.equal(incorrect, false);

    console.log('Tạo băm mật khẩu thành công.');
    console.log('Kiểm tra đúng mật khẩu:', correct);
    console.log('Kiểm tra sai mật khẩu:', incorrect);
    console.log('Hoàn tất kiểm tra hàm mật khẩu.');
  })().catch((error) => {
    console.error('Kiểm tra thất bại:', error.code || error.name);
    process.exitCode = 1;
  });
}