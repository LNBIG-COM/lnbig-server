/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

const debug = require('debug')('lnbig:find-best-fee')

module.exports = function (smallData, bigData = smallData)
{
    let {amount: smallAmount, percent: smallPercent} = smallData
    let {amount: bigAmount, percent: bigPercent} = bigData

    let rate
    let base

    if (smallPercent > bigPercent) {
        // Подобрать такие base & rate, чтобы на малых суммах процент был выше (обратное сделать нельзя)
        rate = (smallPercent * smallAmount - bigPercent * bigAmount)/(smallAmount - bigAmount)
        // base измеряется в миллисатошах, а суммы - в сатошах. Поэтому тут умножение на 1000
        base = bigAmount * (bigPercent - rate) * 1000
        debug('Комиссии small (%f) и big (%f) отличаются, rate_per_mil=%d, base=%d', smallPercent, bigPercent, Math.round(rate * 1000000), Math.round(base))
    }
    else {
        rate = Math.max(smallPercent, bigPercent)
        base = 0
        debug('Комиссии small и big равны (%f), rate_per_mil=%d, base=0', rate, Math.round(rate * 1000000))
    }

    // { base_fee_msat, fee_per_mil, fee_rate }
    return {
        base_fee_msat: Math.round(base) || 1,
        fee_per_mil: Math.round(rate * 1000000) || 1,
        fee_rate: (Math.round(rate * 1000000) || 0) / 1000000
    }
}
