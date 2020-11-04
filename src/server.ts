import 'dotenv/config'

import express from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import compression from 'compression'
import session from 'express-session'
import Keycloak from 'keycloak-connect'
import axios from 'axios'
import mongoose from 'mongoose'

import { createLoginUrl } from './util/kc-helpers'

import Doctor from './models/Doctor'

// We use axios for queries to the iHub Server
axios.defaults.baseURL = process.env.IHUB_ADDRESS!

export const app = express()

//
//
// //////////////////////////////
//            Middleware
// //////////////////////////////
//
//

const AllowedOrigins = ['http://localhost:3000', 'https://boldo.penguin.software']
app.use(cors({ origin: AllowedOrigins, credentials: true }))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())
app.use(compression())

//
//
// //////////////////////////////
//            Keycloak
// //////////////////////////////
//
//

let kcConfig = {
  realm: 'iHub',
  'auth-server-url': process.env.KEYCLOAK_ADDRESS!,
  'ssl-required': 'external',
  resource: 'boldo-doctor',
  'public-client': true,
  'verify-token-audience': true,
  'use-resource-role-mappings': true,
  'confidential-port': 0,
}

const memoryStore = new session.MemoryStore()
app.use(session({ secret: process.env.SECRET!, resave: false, saveUninitialized: true, store: memoryStore }))

// FIXME: We should try if we can configure KC with cookies instead of sessions
// FIXME: Enable offline_acess scope and make sure we make use of it
// BUT: Offline Scope might not be the best to add for doctors as they would essentially be constantly logged in.
// Better to find a way in the client to keep the doctor logged in while using the app?
export const keycloak = new Keycloak(
  {
    store: memoryStore,
    //scope: 'offline_access',
  },
  kcConfig
)

// Never use redirects. Always send 401.
keycloak.redirectToLogin = () => false
keycloak.accessDenied = (req, res) => {
  res.status(401).send({ message: createLoginUrl(req, '/login') })
}

app.set('trust proxy', true)
app.use(keycloak.middleware())

//
//
// //////////////////////////////
//            ROUTES
// //////////////////////////////
//
//

app.get('/', (req, res) => {
  res.send('<h1>Hello, nice to meet you 🤖</h1>')
})

app.get('/login', keycloak.protect(), (req, res) => {
  res.redirect(process.env.CLIENT_ADDRESS!)
})

app.get('/me', keycloak.protect(), (req, res) => {
  const kauth = (req as any).kauth

  res.send({ type: 'string', id: 'string', name: 'string', email: kauth?.grant.access_token?.content?.email })
})

//
// DOCTORS:
// Routes for public doctor profile information
// POST /doctors - Fetch all doctors
//

app.get('/doctors', async (req, res) => {
  try {
    const resp = await axios.get(`/doctors?${req.originalUrl.split('?')[1]}`)
    res.send({ doctors: resp.data })
  } catch (err) {
    console.log(err)
    res.status(400).send({ message: 'Failed to fetch data' })
  }
})

app.get('/doctors/:id', async (req, res) => {
  try {
    const resp = await axios.get(`/doctors/${req.params.id}`)
    res.send(resp.data)
  } catch (err) {
    console.log(err)
    res.status(400).send({ message: 'Failed to fetch data' })
  }
})

//
// PROFILE:
// Protected Routes for managing profile information
// GET /profile/doctor - Read doctor details
// POST /profile/doctor - Update doctor details
// GET /profile/patient - Read patient details
// POST /profile/patient - Update patient details
//

app.get('/profile/doctor', keycloak.protect('doctor'), async (req, res) => {
  try {
    const doctor = await Doctor.findById((req as any).kauth?.grant.access_token.content.sub)

    const openHours = doctor?.openHours || {
      mon: [],
      tue: [],
      wed: [],
      thu: [],
      fri: [],
      sat: [],
      sun: [],
    }

    const resp = await axios.get('/profile/doctor', {
      headers: {
        Authorization: `Bearer ${(req as any).kauth?.grant.access_token.token}`,
      },
    })

    res.send({ ...resp.data, openHours })
  } catch (err) {
    // FIXME: Should never return 404.
    if (err.response?.status === 404) return res.send(null)

    console.log(err)
    res.status(500).send({ message: 'Failed to fetch data' })
  }
})

app.post('/profile/doctor', keycloak.protect('doctor'), async (req, res) => {
  const { openHours, ...ihubPayload } = req.body
  try {
    await Doctor.findOneAndUpdate(
      { _id: (req as any).kauth?.grant.access_token.content.sub },
      { openHours },
      { upsert: true }
    )

    await axios.put('/profile/doctor', ihubPayload, {
      headers: {
        Authorization: `Bearer ${(req as any).kauth?.grant.access_token.token}`,
      },
    })
  } catch (err) {
    if (err.response?.data) {
      console.log(err.response?.data)
      return res.send(err.response.data)
    } else {
      console.log(err)
      return res.sendStatus(500)
    }
  }

  res.sendStatus(200)
})

app.get('/profile/patient', keycloak.protect(), async (req, res) => {
  try {
    const resp = await axios.get('/profile/patient', {
      headers: {
        Authorization: `Bearer ${(req as any).kauth?.grant.access_token.token}`,
      },
    })
    res.send({ ...resp.data })
  } catch (err) {
    // FIXME: Should never return 404.
    if (err.response?.status === 404) return res.send(null)

    console.log(err)
    res.status(500).send({ message: 'Failed to fetch data' })
  }
})

app.post('/profile/patient', keycloak.protect(), async (req, res) => {
  const payload = req.body
  try {
    await axios.put('/profile/patient', payload, {
      headers: {
        Authorization: `Bearer ${(req as any).kauth?.grant.access_token.token}`,
      },
    })
  } catch (err) {
    if (err.response?.data) {
      console.log(err.response?.data)
      return res.send(err.response.data)
    } else {
      console.log(err)
      return res.sendStatus(500)
    }
  }

  res.sendStatus(200)
})

//
// Utils:
// Official List of Doctor Specializations
// GET /specializations - List doctor specializations
// GET /presigned - List doctor specializations
//

app.get('/specializations', keycloak.protect(), async (req, res) => {
  try {
    const resp = await axios.get('/specializations', {
      headers: {
        Authorization: `Bearer ${(req as any).kauth?.grant.access_token.token}`,
      },
    })
    res.send(resp.data)
  } catch (err) {
    console.log(err.response?.data || err)
    return res.sendStatus(500)
  }
})

app.get('/presigned', keycloak.protect(), async (req, res) => {
  try {
    const resp = await axios.get('/s3/presigned', {
      headers: {
        Authorization: `Bearer ${(req as any).kauth?.grant.access_token.token}`,
      },
    })
    res.send(resp.data)
  } catch (err) {
    console.log(err.response?.data || err)
    return res.sendStatus(500)
  }
})

//
//
// //////////////////////////////
//        START SERVER
// //////////////////////////////
//
//

https: if (require.main === module) {
  mongoose
    .connect(`${process.env.MONGODB_URI}`, {
      useNewUrlParser: true,
      useCreateIndex: true,
      useFindAndModify: false,
      useUnifiedTopology: true,
    })
    .then(() => {
      const PORT = process.env.PORT || 8008
      app.listen(PORT, () => console.info(`Running on ${PORT}`))
    })
    .catch(err => {
      console.log(err)
      process.exit(1)
    })
}
