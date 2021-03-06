'use strict'

const IPFSRepo = require('ipfs-repo')
const path = require('path')
const ncp = require('ncp')
const rimraf = require('rimraf')
const testRepoPath = path.join(__dirname, 'test-repo')
const each = require('async/each')

// book keeping
let repos = []

function createRepo (id, done) {
  const date = Date.now().toString()
  const repoPath = `${testRepoPath}-for-${date}-${id}`
  ncp(testRepoPath, repoPath, (err) => {
    if (err) return done(err)

    const repo = new IPFSRepo(repoPath)
    repo.open((err) => {
      if (err) {
        return done(err)
      }
      repos.push(repoPath)
      done(null, repo)
    })
  })
}

function removeRepos (done) {
  each(repos, (repo, cb) => {
    rimraf(repo, cb)
  }, (err) => {
    repos = []
    done(err)
  })
}

const repo = {
  create: createRepo,
  remove: removeRepos
}

require('./index-test')(repo)
require('./components/decision-engine/index-test')(repo)
require('./components/network/network.node.js')
require('./components/network/gen-bitswap-network.node.js')
