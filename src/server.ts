import 'dotenv/config'

import express from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import compression from 'compression'
import session from 'express-session'
import Keycloak from 'keycloak-connect'
import axios from 'axios'
import mongoose from 'mongoose'
import { differenceInHours, differenceInMinutes, parseISO } from 'date-fns'

import { createLoginUrl } from './util/kc-helpers'

import Doctor from './models/Doctor'
import Appointment from './models/Appointment'
import CoreAppointment from './models/CoreAppointment'

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

app.use((req, res, next) => {
  req.userId = (req as any).kauth?.grant?.access_token?.content?.sub
  next()
})

const getAccessToken = (req: any) => {
  return req.kauth?.grant?.access_token?.token
}

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

//
// PROFILE:
// Protected Routes for managing profile information
// GET /profile/doctor - Read doctor details
// GET /profile/doctor/openHours - Read doctor details
// POST /profile/doctor - Update doctor details
// GET /profile/patient - Read patient details
// POST /profile/patient - Update patient details
//

app.get('/profile/doctor', keycloak.protect('realm:doctor'), async (req, res) => {
  try {
    const doctor = await Doctor.findById(req.userId)
    const openHours = doctor?.openHours || { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] }

    const resp = await axios.get('/profile/doctor', { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })

    res.send({ ...resp.data, openHours })
  } catch (err) {
    console.log(err)
    res.status(500).send({ message: 'Failed to fetch data' })
  }
})

app.get('/profile/doctor/openHours', keycloak.protect('realm:doctor'), async (req, res) => {
  try {
    const doctor = await Doctor.findById(req.userId)
    const openHours = doctor?.openHours || { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] }

    res.send(openHours)
  } catch (err) {
    console.log(err)
    res.sendStatus(500)
  }
})

app.post('/profile/doctor', keycloak.protect('realm:doctor'), async (req, res) => {
  const { openHours, ...ihubPayload } = req.body
  try {
    await Doctor.findOneAndUpdate({ _id: req.userId }, { openHours }, { upsert: true })

    await axios.put('/profile/doctor', ihubPayload, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
  } catch (err) {
    if (err.response?.data) {
      console.log(err.response?.data)
      return res.status(400).send(err.response.data)
    } else {
      console.log(err)
      return res.sendStatus(500)
    }
  }

  res.sendStatus(200)
})

app.post('/profile/patient', keycloak.protect(), async (req, res) => {
  const payload = req.body
  try {
    await axios.put('/profile/patient', payload, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
  } catch (err) {
    if (err.response) {
      console.log(err.response.data)
      return res.status(400).send(err.response.data)
    } else {
      console.log(err)
      return res.sendStatus(500)
    }
  }

  res.sendStatus(200)
})

//
// APPOINTMENTS for DOCTORS:
// Protected Routes for managing profile information
// GET /profile/doctor/appointments - Read appointments of Doctor
// GET /profile/doctor/appointments/:id - Read appointment of Doctor
// POST /profile/doctor/appointments/:id - Update appointment of Doctor
// GET /profile/doctor/appointments/openAppointments - Read appointments of Doctor that have open WaitingRoom
// POST /profile/doctor/appointments - Create appontment for Doctor
// DELETE /profile/doctor/appointments/:id - Delete appontment for Doctor
//

// FIXME: Should be scoped to start and end date
app.get('/profile/doctor/appointments', keycloak.protect('realm:doctor'), async (req, res) => {
  try {
    const appointments = await Appointment.find({ doctorId: req.userId })

    const resp = await axios.get<iHub.Appointment[]>('/profile/doctor/appointments?include=patient', {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })

    const FHIRAppointments = resp.data.map(event => ({ ...event, type: 'Appointment' }))

    res.send([...FHIRAppointments, ...appointments])
  } catch (err) {
    console.log(err)
    res.status(500).send({ message: 'Failed to fetch data' })
  }
})

app.get('/profile/doctor/appointments/openAppointments', keycloak.protect('realm:doctor'), async (req, res) => {
  // FIXME: It seems like KC allows for request using tokens that are timed out already.

  try {
    // FIXME: Request Should be scoped to start and end date
    const resp = await axios.get<iHub.Appointment[]>('/profile/doctor/appointments?include=patient', {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })

    const upcomingAppointments = resp.data.filter(appointment => {
      const minutes = differenceInMinutes(parseISO(appointment.start as any), Date.now())
      const hours = differenceInHours(parseISO(appointment.start as any), Date.now())
      return minutes < 15 && hours > -24
    })

    res.send(upcomingAppointments)
  } catch (err) {
    console.log(err)
    res.status(500).send({ message: 'Failed to fetch data' })
  }
})

app.get('/profile/doctor/appointments/:id', keycloak.protect('realm:doctor'), async (req, res) => {
  try {
    const resp = await axios.get<iHub.Appointment>(`/profile/doctor/appointments/${req.params.id}?include=patient`, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })

    const appointment = resp.data

    const minutes = differenceInMinutes(parseISO(appointment.start as any), Date.now())
    let status = 'upcoming'
    if (minutes < 15) {
      const appointmentAddon = await CoreAppointment.findOne({ id: req.params.id })
      status = appointmentAddon?.status || 'open'
    }
    res.send({ ...resp.data, type: 'Appointment', status })
  } catch (err) {
    handleError(req, res, err)
  }
})

app.post('/profile/doctor/appointments', keycloak.protect('realm:doctor'), async (req, res) => {
  if (!req.userId) return res.sendStatus(500)
  const { type, name, start, end, description } = req.body

  if (type === 'PrivateEvent') {
    try {
      const appointment = await Appointment.create({ type, name, start, end, description, doctorId: req.userId })
      res.send(appointment)
    } catch (err) {
      console.log(err)
      return res.sendStatus(500)
    }
  }
})

app.post('/profile/doctor/appointments/:id', keycloak.protect('realm:doctor'), async (req, res) => {
  try {
    // Get Appointment and check for access rights
    const resp = await axios.get<iHub.Appointment>(`/profile/doctor/appointments/${req.params.id}`, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    const respp = await axios.get<iHub.Appointment>(`/profile/doctor`, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    if (resp.data.doctorId !== respp.data.id) return res.sendStatus(400)
    await CoreAppointment.updateOne({ id: req.params.id }, { $set: { status: 'closed' } }, { upsert: true })
    res.sendStatus(200)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.delete('/profile/doctor/appointments/:id', keycloak.protect('realm:doctor'), async (req, res) => {
  try {
    await Appointment.deleteOne({ _id: req.params.id, doctorId: req.userId })
    res.sendStatus(200)
  } catch (error) {
    console.log(error)
    if (error.message) return res.status(400).send({ message: error.message })
    res.sendStatus(500)
  }
})

//
// APPOINTMENTS for PATIENTS:
// Protected Routes for managing profile information
// GET /profile/patient/appointments - Read appointments of Patient
// POST /profile/patient/appointments - Create appontment for Patient

//
app.get('/profile/patient/appointments', keycloak.protect('realm:patient'), async (req, res) => {
  try {
    const resp = await axios.get<iHub.Appointment[]>('/profile/patient/appointments?include=doctor', {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })

    const ids = resp.data.map(app => app.id)
    const appointmentsAddon = await CoreAppointment.find({ id: { $in: ids } })

    const FHIRAppointments = resp.data.map(event => {
      let status = 'upcoming'
      const minutes = differenceInMinutes(parseISO(event.start as any), Date.now())
      if (minutes < 15) {
        const appointmentAddon = appointmentsAddon.find(app => app.id === event.id)
        status = appointmentAddon?.status || 'open'
      }
      return { ...event, type: 'Appointment', status }
    })

    res.send(FHIRAppointments)
  } catch (err) {
    console.log(err)
    res.status(500).send({ message: 'Failed to fetch data' })
  }
})

app.post('/profile/patient/appointments', keycloak.protect(), async (req, res) => {
  const payload = req.body

  const end = new Date(payload.start)
  end.setMinutes(end.getMinutes() + 30)

  try {
    const resp = await axios.post(
      '/profile/patient/appointments',
      { ...payload, end: end.toISOString().replace('Z', '-0000') },
      {
        headers: { Authorization: `Bearer ${getAccessToken(req)}` },
      }
    )
    res.send(resp.data)
  } catch (err) {
    if (err.response) {
      console.log(err.response.data)
      return res.status(400).send(err.response.data)
    } else {
      console.log(err)
      return res.sendStatus(500)
    }
  }
})

//
// Doctor
// Public Routes for searching Doctors
// GET /doctors - Fetch and search doctors
// GET /doctors/:id - Fetch doctor details
// GET /doctors/:id/availability - Fetch doctor details
//
app.get('/doctors', async (req, res) => {
  try {
    const queryString = req.originalUrl.split('?')[1]

    const resp = await axios.get<{ items: iHub.Doctor[]; total: number }>(`/doctors${queryString ? `?${queryString}` : ''}`)

    const createRandomFutureDate = () => {
      const date = new Date()
      date.setDate(date.getDate() + Math.floor(Math.random() * 10) + Math.floor(Math.random() * 10))
      return date
    }

    const doctorsWithNextAvailability = resp.data.items.map(doctor => ({
      ...doctor,
      nextAvailability: createRandomFutureDate(),
    }))

    res.send(doctorsWithNextAvailability)
  } catch (err) {
    console.log(err)
    res.sendStatus(500)
  }
})

app.get('/doctors/:id', async (req, res) => {
  try {
    const resp = await axios.get<iHub.Doctor>(`/doctors/${req.params.id}`)
    res.send(resp.data)
  } catch (err) {
    console.log(err)
    res.sendStatus(500)
  }
})

app.get('/doctors/:id/availability', async (req, res) => {
  try {
    const resp = await axios.get<iHub.Doctor>(`/doctors/${req.params.id}`)
    if (!resp.data) return res.status(400).send({ message: 'No Doctor with this id' })

    const minutes = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]
    const hours = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]

    const createRandomAvailability = () => {
      const date = new Date()
      date.setDate(date.getDate() + Math.floor(Math.random() * 10) + Math.floor(Math.random() * 10))
      date.setHours(hours[(hours.length * Math.random()) | 0])
      date.setMinutes(minutes[(minutes.length * Math.random()) | 0])
      date.setSeconds(0)
      date.setMilliseconds(0)
      return date
    }

    const availabilities = []

    for (let i = 0; i <= 50; i++) {
      availabilities.push(createRandomAvailability())
    }

    res.send({ ...resp.data, availabilities, nextAvailability: createRandomAvailability() })
  } catch (err) {
    console.log(err)
    res.sendStatus(500)
  }
})

//
// Utils:
// GET /presigned - List doctor specializations
//

app.get('/presigned', keycloak.protect(), async (req, res) => {
  try {
    const resp = await axios.get('/s3/presigned', { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.send(resp.data)
  } catch (err) {
    console.log(err.response?.data || err)
    return res.sendStatus(500)
  }
})

//
// Forward all other GET endpoints:
// EXAMPLES:
// GET /specializations - List doctor specializations
// GET /profile/patient - Read patient details
// POST /profile/patient - Update patient details
//

app.get('*', async (req, res) => {
  const token = getAccessToken(req)
  try {
    const resp = await axios.get(req.originalUrl, { ...(!!token && { headers: { Authorization: `Bearer ${token}` } }) })
    return res.send(resp.data)
  } catch (err) {
    if (err.response) {
      if (err.response.status === 401) return res.status(401).send({ message: createLoginUrl(req, '/login') })
      console.log('axios:', err.response.data || err.message)
      return res.status(err.response.status).send(err.response.data)
    } else {
      console.log(err)
      return res.sendStatus(500)
    }
  }
})

app.post('*', async (req, res) => {
  const payload = req.body || {}
  const token = getAccessToken(req)
  try {
    const resp = await axios.put(req.originalUrl, payload, {
      ...(!!token && { headers: { Authorization: `Bearer ${token}` } }),
    })
    return res.send(resp.data)
  } catch (err) {
    if (err.response) {
      if (err.response.status === 401) return res.status(401).send({ message: createLoginUrl(req, '/login') })
      console.log('axios:', err.response.data || err.message)
      return res.status(err.response.status).send(err.response.data)
    } else {
      console.log(err)
      return res.sendStatus(500)
    }
  }
})

//
//
// //////////////////////////////
//        START SERVER
// //////////////////////////////
//
//

if (require.main === module) {
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

//
//
// //////////////////////////////
//        HELPER
// //////////////////////////////
//
//

const handleError = (req: express.Request, res: express.Response, err: any) => {
  console.log(err.message, err.name)
  if (err.response) {
    if (err.response.status === 401) return res.status(401).send({ message: createLoginUrl(req, '/login') })
    console.log('axios:', err.response.data || err.message)
    return res.status(err.response.status).send(err.response.data)
  } else {
    console.log(err)
    return res.sendStatus(500)
  }
}
