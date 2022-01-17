// const { Worker, isMainThread, parentPort, workerData } = require('worker_threads')

// /** @typedef {[number, number]} Interval */

// // Source and explanation: https://stackoverflow.com/a/6463030/5157205
// /**
//  * @param {Interval} r1
//  * @param {Interval} r2
//  */
// const rangeDiff = (r1, r2) => {
//   const [s1, e1] = r1
//   const [s2, e2] = r2
//   const endpoints = [s1, e1, s2, e2].sort((a, b) => a - b)

//   /**
//    * @type {Interval[]}
//    */
//   const result = []
//   if (endpoints[0] === s1) result.push([endpoints[0], endpoints[1]])
//   if (endpoints[3] === e1) result.push([endpoints[2], endpoints[3]])
//   return result
// }

// /**
//  * @param {[Interval,string][]} r1_list
//  * @param {Interval[]} r2_list
//  */

// const multirangeDiff = (r1_list, r2_list) => {
//   r2_list.forEach(r2 => {
//     /**
//      * @type {[Interval,string][]}
//      */
//     let list = []
//     r1_list.forEach(r1 => {
//       let aux = [...list, ...rangeDiff(r1[0], r2).map(e => [e,r1[1]]) ] 
//       list = aux as [Interval,string][]
//     })
//     r1_list = list
//   })

//   return r1_list
// }

// /**
//  * Takes `base`, a list of intervals and `substract` another list of intervals.
//  * Returns base - substract.
//  *
//  * @param {object} data
//  * @param {[Interval,String][]} data.base
//  * @param {Interval[]} data.substract
//  * @returns {Promise<[Interval,string][]>}
//  */

// module.exports = function calculateOpenIntervals(data) {
//   return new Promise((resolve, reject) => {
//     const worker = new Worker(__filename, { workerData: data })
//     worker.on('message', resolve)
//     worker.on('error', reject)
//     worker.on('exit', code => {
//       if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`))
//     })
//   })
// }

// if (!isMainThread) {
//   const freeIntervals = multirangeDiff(workerData.base, workerData.substract)
//   parentPort?.postMessage(freeIntervals)
// }
import {Interval} from '../util/helpers'

// Source and explanation: https://stackoverflow.com/a/6463030/5157205
 const rangeDiff = (r1 : Interval, r2: Interval) => {
  const [s1, e1] = r1 
  const [s2, e2] = r2
  const endpoints = [s1, e1, s2, e2].sort((a, b) => a - b)
  const result = []
  if (endpoints[0] === s1) result.push([endpoints[0], endpoints[1]])
  if (endpoints[3] === e1) result.push([endpoints[2], endpoints[3]])
  return result
}


export const calculateOpenIntervals = (r1_list: [Interval,string][], r2_list:Interval[]) => {
  r2_list.forEach(r2 => {
    let list = [] as [Interval,string][]
    r1_list.forEach(r1 => {
      let aux = [...list, ...rangeDiff(r1[0], r2).map(e => [e,r1[1]]) ] 
      list = aux as [Interval,string][]
    })
    r1_list = list
  })

  return r1_list
}