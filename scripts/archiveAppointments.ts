import 'dotenv/config'

import mongoose from 'mongoose'
import axios from 'axios'
import express from 'express'
import CoreAppointment from '../src/models/CoreAppointment'

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
  await mongoose.connect(`${process.env.MONGODB_URI}`, {
    useNewUrlParser: true,
    useCreateIndex: true,
    useFindAndModify: false,
    useUnifiedTopology: true,
  })

  const hoursAgo = new Date()
  hoursAgo.setHours(hoursAgo.getHours() - 2)

  try {
    const res = await CoreAppointment.updateMany(
      { date: { $lte: hoursAgo }, status: { $ne: 'locked' } },
      { status: 'locked' }
    )
    console.log('🏛 ✅ DAILY ARCHIVE ORDERS TASK RESULTS: ', res)
  } catch (err) {
    console.log(err)
  }
  mongoose.disconnect()

  const authentication =await keycloak.grantManager.obtainDirectly(process.env.BOLDO_ADMIN, process.env.BOLDO_PASS)
  const boldoToken = authentication.access_token.token
  const response = await axios.put(`/profile/admin/encounter/status`,{}, {
    headers: { Authorization: `Bearer ${boldoToken}` },
  })
  console.log("Encounter status update: ",response.status)
  
}

if (require.main === module) {
  archiveAppointments()
}
