import 'dotenv/config'

import mongoose from 'mongoose'
import axios from 'axios'
import express from 'express'
import {ICoreAppointment, CoreAppointmentSchema} from '../models/CoreAppointment'

// This script updates the status of CoreAppointments Documents in MongoDB 
// It is executed periodically by a crontab 
// TODO: make it a ENV var 

var Keycloak = require('keycloak-connect');
const session = require('express-session');
axios.defaults.baseURL = process.env.IHUB_ADDRESS!
export const app = express()

let kcConfig = {
  realm: 'iHub',
  'auth-server-url': process.env.KEYCLOAK_ADDRESS,
  'ssl-required': 'external',
  resource: 'boldo-doctor',
  'public-client': true,
  'verify-token-audience': true,
  'use-resource-role-mappings': true,
  'confidential-port': 0
}

var memoryStore = new session.MemoryStore();

const keycloak = new Keycloak({
  store: memoryStore
},
kcConfig)


export const archiveAppointments = async () => {
  let conn = await mongoose.createConnection(`${process.env.MONGODB_URI}`, {
    useNewUrlParser: true,
    useCreateIndex: true,
    useFindAndModify: false,
    useUnifiedTopology: true,
    socketTimeoutMS:50000
  })

  const hoursAgo = new Date()
  hoursAgo.setHours(hoursAgo.getHours() - 2)

  try {
    let coreAppointmentModel = conn.model<ICoreAppointment>('CoreAppointment', CoreAppointmentSchema) //access to model via the connection
    const res = await coreAppointmentModel.updateMany(
      { date: { $lte: hoursAgo }, status: {$nin :["cancelled","locked"]} },
      { status: 'locked' }
    )
    console.log('SCRIPT LOG: 🏛 ✅ DAILY ARCHIVE ORDERS TASK RESULTS: ', res)
  } catch (err) {
    console.log(err)
  } finally {
    await conn.close()
  }

  const authentication =await keycloak.grantManager.obtainDirectly(process.env.BOLDO_ADMIN, process.env.BOLDO_PASS)
  const boldoToken = authentication.access_token.token
  const response = await axios.put(`/profile/admin/encounter/status`,{}, {
    headers: { Authorization: `Bearer ${boldoToken}` },
  })
  console.log("SCRIPT LOG: Core-health-mapper 🔥 -> Encounter status update: ", response.status + " " + response.statusText)

}

if (require.main === module) {
  archiveAppointments()
}
