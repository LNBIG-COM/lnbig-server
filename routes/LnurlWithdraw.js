const debug = require('debug')('lnbig:routes:lnurl-withdraw')
const billingNode = require('../global/billingNode')

// Это callback УРЛ для сервиса lnurl-withdraw
module.exports = function (router, uri) {
    router.get(
        uri,
        async (ctx) => {
            debug("Поступил запрос /lnurl-withdraw, query: %o", ctx.query)

            try {
                let uuid = ctx.query.k1

                if (! /^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/.test(uuid)) {
                    throw new Error('The k1 parameter is not correct')
                }
                uuid = String(uuid)

                if (ctx.query.stage && ctx.query.stage == 1) {
                    // Шаг 1 - получение JSON объекта при запросе
                    let obj = await billingNode.findClaimRequest(uuid)

                    if (obj) {
                        ctx.response.body = obj.lnurlObj
                    }
                    else {
                        throw new Error('Invalid QR code for withdraw')
                    }
                }
                else {
                    // Шаг 2 - это уже callback от кошелька
                    let invoiceList = ctx.query.pr.split(',')

                    if (invoiceList.length > 1)
                        throw new Error("Your wallet has created more than one invoice. We don't support multiple invoices!")

                    let obj = await billingNode.findClaimRequest(uuid)
                    await billingNode.checkAndPayInvoiceForClaim(obj.uuid, invoiceList[0])
                    ctx.response.body = {status: "OK"}
                }
            }
            catch (e) {
                ctx.response.body = { status: "ERROR", reason: e.message};
            }
        }
    );
}
