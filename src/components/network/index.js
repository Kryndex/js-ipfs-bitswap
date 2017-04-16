'use strict'

const debug = require('debug')
const lp = require('pull-length-prefixed')
const pull = require('pull-stream')
const waterfall = require('async/waterfall')
const each = require('async/each')

const Message = require('../../types/message')
const CONSTANTS = require('../../constants')
const log = debug('bitswap:network')
log.error = debug('bitswap:network:error')

const BITSWAP100 = '/ipfs/bitswap/1.0.0'
const BITSWAP110 = '/ipfs/bitswap/1.1.0'

class Network {
  constructor (libp2p, peerBook, bitswap, b100Only) {
    this.libp2p = libp2p
    this.peerBook = peerBook
    this.bitswap = bitswap
    this.b100Only = b100Only || false

    // increase event listener max
    this._running = false
    this.libp2p.swarm.setMaxListeners(CONSTANTS.maxListeners)
  }

  start () {
    this._running = true
    // bind event listeners
    this._onPeerConnect = this._onPeerConnect.bind(this)
    this._onPeerDisconnect = this._onPeerDisconnect.bind(this)

    this._onConnection = this._onConnection.bind(this)
    this.libp2p.handle(BITSWAP100, this._onConnection)
    if (!this.b100Only) {
      this.libp2p.handle(BITSWAP110, this._onConnection)
    }

    this.libp2p.on('peer:connect', this._onPeerConnect)
    this.libp2p.on('peer:disconnect', this._onPeerDisconnect)

    // All existing connections are like new ones for us
    const pKeys = Object.keys(this.peerBook.getAll())
    pKeys.forEach((k) => this._onPeerConnect(this.peerBook.get(k)))
  }

  stop () {
    this._running = false

    this.libp2p.unhandle(BITSWAP100)
    if (!this.b100Only) {
      this.libp2p.unhandle(BITSWAP110)
    }

    this.libp2p.removeListener('peer:connect', this._onPeerConnect)
    this.libp2p.removeListener('peer:disconnect', this._onPeerDisconnect)
  }

  // Handles both types of bitswap messgages
  _onConnection (protocol, conn) {
    if (!this._running) {
      return
    }
    log('incomming new bitswap connection: %s', protocol)
    pull(
      conn,
      lp.decode(),
      pull.asyncMap((data, cb) => Message.deserialize(data, cb)),
      pull.asyncMap((msg, cb) => {
        conn.getPeerInfo((err, peerInfo) => {
          if (err) {
            return cb(err)
          }
          // log('data from', peerInfo.id.toB58String())
          this.bitswap._receiveMessage(peerInfo.id, msg, cb)
        })
      }),
      pull.onEnd((err) => {
        log('ending connection')
        if (err) {
          return this.bitswap._receiveError(err)
        }
      })
    )
  }

  _onPeerConnect (peerInfo) {
    if (!this._running) {
      return
    }

    this.bitswap._onPeerConnected(peerInfo.id)
  }

  _onPeerDisconnect (peerInfo) {
    if (!this._running) {
      return
    }

    this.bitswap._onPeerDisconnected(peerInfo.id)
  }

  connectTo (peerId, callback) {
    if (!this._running) {
      return callback(new Error('No running network'))
    }

    this.libp2p.dial(peerId, callback)
  }

  findProviders (cid, maxProviders, callback) {
    this.libp2p.dht.findNProviders(cid, CONSTANTS.providerRequestTimeout, maxProviders, callback)
  }

  findAndConnect (cid, maxProviders, callback) {
    waterfall([
      (cb) => this.findProviders(cid, maxProviders, cb),
      (provs, cb) => each(provs, (p, cb) => this.connectTo(p, cb))
    ], callback)
  }

  provide (cid, callback) {
    this.libp2p.contentRouting.provide(cid, callback)
  }

  // Connect to the given peer
  // Send the given msg (instance of Message) to the given peer
  sendMessage (peerId, msg, callback) {
    if (!this._running) {
      return callback(new Error('No running network'))
    }

    const stringId = peerId.toB58String()
    log('sendMessage to %s', stringId, msg)

    this._dialPeer(peerId, (err, conn, protocol) => {
      if (err) {
        return callback(err)
      }

      let serialized
      switch (protocol) {
        case BITSWAP100:
          serialized = msg.serializeToBitswap100()
          break
        case BITSWAP110:
          serialized = msg.serializeToBitswap110()
          break
        default:
          return callback(new Error('Unkown protocol: ' + protocol))
      }
      writeMessage(conn, serialized, (err) => {
        if (err) {
          log(err)
        }
      })
      callback()
    })
  }

  _dialPeer (peer, callback) {
    // dialByPeerInfo throws if no network is there
    try {
     // Attempt Bitswap 1.1.0
      this.libp2p.dial(peer, BITSWAP110, (err, conn) => {
        if (err) {
          // Attempt Bitswap 1.0.0
          this.libp2p.dial(peer, BITSWAP100, (err, conn) => {
            if (err) {
              return callback(err)
            }

            callback(null, conn, BITSWAP100)
          })
          return
        }

        callback(null, conn, BITSWAP110)
      })
    } catch (err) {
      return callback(err)
    }
  }
}

function writeMessage (conn, msg, callback) {
  pull(
    pull.values([msg]),
    lp.encode(),
    conn,
    pull.onEnd(callback)
  )
}

module.exports = Network
