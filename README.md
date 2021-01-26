LNBIG server sources
====================

This is the source code of the LNBIG project **as it is**. There are no
guarantees! These are snapshots of two versions (separated by git
branches) of the project:

1. `master` - The current server part for the [LNBIG.com](https://lnbig.com/)
   server part
2. `new_open_channel` - the server part for utilities and regular
   actions to maintain the network: its own autopilot for opening
   channels, scripts for rebalancing, calculating statistics, etc. This
   part also consists the new server part for the new version of site
   (which is in the developing yet)

Directory structure
-------------------

- *adjustChannels*

  The some main utilities for every day server's working. For this i
  have separately unix user `lnbig-test` where the `.env` file has the
  `CRYPT_PASSWORD` password for decrypting LND's *macaroon* files  
  so that automatic procedures can be executed through *cron* files. For
  example my cron files there are:

  ```
  */4 * * * * cd lnbig-server && node adjustChannels/paidRebalance.js --our-nodes >>paid-rebalance.log
  */20 * * * * cd lnbig-server && node adjustChannels/smartRebalance-v2.js >>smart-rebalance.log
  11 */3 * * * cd lnbig-server && node adjustChannels/openCloseChannels.js open >>open-channels.log
  ```

  Here:

  - `node adjustChannels/paidRebalance.js --our-nodes` - the rebalancing
    channels between our nodes
  - `node adjustChannels/smartRebalance-v2.js` - Adjustment of
    commissions for all channels with the "outside world" (not ours
    channels), taking into account their current balances. Thus, I'm
    trying to establish commissions that would stimulate channel
    rebalancing at the expense of channel commissions.
  - `node adjustChannels/openCloseChannels.js open` - Opening channels
    with nodes, the so-called autopilot script. He tries to open
    channels with nodes in such a way as to create balance parity
    between both parties (our and remote ones) in an equal ratio.


- `node amntTransactions/last24.js` - Shows the number of transactions
  for the last 24 hours
- `node feeReport/last24.js` - Shows the fee earnings for the last 24
  hours on transaction fees.
- `global/nodesInfo.js` - A file that is created once automatically by
  my scripts, and which contains the configuration and authorization
  data of my nodes. This is the real file but slightly modified.
- `.env.example` - The '.env' file do node's config environments. It's
  example. You need to copy it to `.env` file and to modify it before
  using.

Other files are not described here yet. Some files are created for
experimentation, others for the next stage of project development. But
at the moment I stopped the development of this project. Perhaps later,
I will continue to develop it further.

P.S. The client code (nodejs & vue framework) is not published yet
because in my opinion does not represent a great desire for researching.
But if there are interested persons, I can also publish it later.

License
-------

To see LICENSE file

Author
------

Anonymous developer of the LNBIG project ([LNBIG.com](https://lnbig.com/) site)
