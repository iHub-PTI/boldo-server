const { type } = require('os')
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads')

/** @typedef {[number, number]} Interval */
/** @typedef {[number, number,string]} Tup */

// Source and explanation: https://stackoverflow.com/a/6463030/5157205
/**
 * @param {Tup} r1
 * @param {Interval} r2
 */
const rangeDiff = (r1, r2) => {
  const [s1, e1, at] = r1
  const [s2, e2] = r2
  const endpoints = [s1, e1, s2, e2].sort((a, b) => a - b)

  /**
   * @type {Tup[]}
   */
  const result = []
  if (endpoints[0] === s1) result.push([endpoints[0], endpoints[1],at])
  if (endpoints[3] === e1) result.push([endpoints[2], endpoints[3],at])
  return result
}

/**
 * @param {Tup[]} r1_list
 * @param {Interval[]} r2_list
 */

const multirangeDiff = (r1_list, r2_list) => {
  r2_list.forEach(r2 => {
    /**
     * @type {Tup[]}
     */
    let list = []
    r1_list.forEach(r1 => {
      list = [...list, ...rangeDiff([r1[0],r1[1],r1[2]], r2)]
      
    })
    r1_list = list
  })

  return r1_list
}

/**
 * Takes `base`, a list of intervals and `substract` another list of intervals.
 * Returns base - substract.
 *
 * @param {object} data
 * @param {Tup[]} data.base
 * @param {Interval[]} data.substract
 * @returns {Promise<Tup[]>}
 */

module.exports = function calculateOpenIntervals(data) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: data })
    worker.on('message', resolve)
    worker.on('error', reject)
    worker.on('exit', code => {
      if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`))
    })
  })
}

if (!isMainThread) {
  const freeIntervals = multirangeDiff(workerData.base, workerData.substract)
  parentPort?.postMessage(freeIntervals)
}