/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

module.exports = {
    MIN_VALUE_FREE_CHANNEL: 2000000,
    MAX_VALUE_FREE_CHANNEL: 5000000,
    FREE_OPEN_CHANNEL_LOCK_TTL: 15 * 60 * 1000, //  Через сколько мс истекают локировки для открытия бесплатных каналов
    OPEN_CHANNEL_LOCK_EXPIRES: 5 * 60 * 1000,   // Даётся пять минут на открытие канала
    RESERVE_OPEN_CHANNEL_SATOSHIES: 50000,       // Сколько резервируется на открытие канала - комиссия
}
