import 'dotenv/config'

import express from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import compression from 'compression'
import session from 'express-session'
import redis from 'redis'
import connectRedis from 'connect-redis'
import Keycloak from 'keycloak-connect'
import axios from 'axios'
import mongoose from 'mongoose'
import { differenceInDays, differenceInMinutes, parseISO } from 'date-fns'
import { body, param, query } from 'express-validator'

import { createLoginUrl } from './util/kc-helpers'
import Doctor from './models/Doctor'
import Appointment, { IAppointment } from './models/Appointment'
import CoreAppointment, { ICoreAppointment } from './models/CoreAppointment'
import {
  calculateAvailability,
  handleError,
  validate,
  APPOINTMENT_LENGTH,
  calculateNextAvailability,
  createToken,
} from './util/helpers'

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
const AllowedOrigins = [process.env.CLIENT_ADDRESS!, 'http://localhost:3000']
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

const RedisStore = connectRedis(session)
const redisClient = redis.createClient(process.env.REDIS_URL!)

app.use(
  session({
    secret: process.env.SECRET!,
    resave: false,
    saveUninitialized: true,
    store: new RedisStore({ client: redisClient }),
  })
)

// FIXME: We should try if we can configure KC with cookies instead of sessions
// FIXME: Enable offline_acess scope and make sure we make use of it
// BUT: Offline Scope might not be the best to add for doctors as they would essentially be constantly logged in.
// Better to find a way in the client to keep the doctor logged in while using the app?
export const keycloak = new Keycloak(
  {
    store: RedisStore,
    //scope: 'offline_access',
  },
  kcConfig
)

// Never use redirects. Always send 401.
keycloak.redirectToLogin = () => false
keycloak.accessDenied = (req, res) => {
  res.status(401).send({ message: createLoginUrl(req, '/login') })
  // FIXME: Check if we should return something here
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
// DOCTOR PROFILE:
// Protected Routes for managing profile information
// GET /profile/doctor - Read doctor details
// POST /profile/doctor - Update doctor details
//

app.get('/profile/doctor', keycloak.protect('realm:doctor'), async (req, res) => {
  try {
    const doctor = await Doctor.findById(req.userId)
    const openHours = doctor?.openHours || { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] }

    const resp = await axios.get('/profile/doctor', { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })

    res.send({ ...resp.data, openHours, new: !doctor })
  } catch (err) {
    handleError(req, res, err)
  }
})

app.post(
  '/profile/doctor',
  keycloak.protect('realm:doctor'),
  body([
    'openHours.mon',
    'openHours.tue',
    'openHours.wed',
    'openHours.thu',
    'openHours.fri',
    'openHours.sat',
    'openHours.sun',
  ]).isArray(),
  body(['openHours.*.*.start', 'openHours.*.*.end']).isInt().toInt(),
  async (req, res) => {
    if (!validate(req, res)) return

    const { openHours, ...ihubPayload } = req.body

    try {
      const resp = await axios.get('/profile/doctor', { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
      await Doctor.findOneAndUpdate({ _id: req.userId, id: resp.data.id }, { openHours }, { upsert: true })

      await axios.put('/profile/doctor', ihubPayload, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
      res.sendStatus(200)
    } catch (err) {
      handleError(req, res, err)
    }
  }
)

//
// PATIENT PROFILE:
// GET /profile/patient - Read patient details
// POST /profile/patient - Update patient details
//

app.get('/profile/patient', keycloak.protect('realm:patient'), async (req, res) => {
  try {
    const resp = await axios.get('/profile/patient', { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.post('/profile/patient', keycloak.protect('realm:patient'), async (req, res) => {
  const payload = req.body
  try {
    await axios.put('/profile/patient', payload, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.sendStatus(200)
  } catch (err) {
    handleError(req, res, err)
  }
})

//
// APPOINTMENTS for DOCTORS:
// Protected routes for managing appointments
// GET /profile/doctor/appointments - Read doctor appointments
// POST /profile/doctor/appointments - Create doctor appointment
// GET /profile/doctor/appointments/:id - Read doctor appointment
// POST /profile/doctor/appointments/:id - Update doctor appointment
// DELETE /profile/doctor/appointments/:id - Delete doctor appointment
//

app.get(
  '/profile/doctor/appointments',
  keycloak.protect('realm:doctor'),
  query(['start', 'end']).isISO8601().optional(),
  query('status').isString().optional(),
  async (req, res) => {
    if (!validate(req, res)) return

    const { status, start, end } = req.query

    try {
      const { data } = await axios.get<iHub.Appointment[]>(
        `/profile/doctor/appointments?include=patient${start && end ? `&start=${start}&end=${end}` : ''}`,
        {
          headers: { Authorization: `Bearer ${getAccessToken(req)}` },
        }
      )
      const ids = data.map(appointment => appointment.id)
      const coreAppointments = await CoreAppointment.find({ id: { $in: ids } })

      let FHIRAppointments = [] as (iHub.Appointment & { type: string; status: ICoreAppointment['status'] })[]

      FHIRAppointments = coreAppointments.map(appointment => {
        const FHIRAppointment = data.find(app => app.id === appointment.id)
        if (!FHIRAppointment) throw new Error(`FHIR Appointment must exist but not found for ID: ${appointment.id}!`)

        const minutes = differenceInMinutes(parseISO(FHIRAppointment.start as any), Date.now())
        if (minutes < 15 && appointment.status === 'upcoming') {
          return { ...FHIRAppointment, type: 'Appointment', status: 'open' }
        } else {
          return { ...FHIRAppointment, type: 'Appointment', status: appointment.status }
        }
      })

      let token = ''
      if (status) {
        FHIRAppointments = FHIRAppointments.filter(appointment => appointment.status === status)
        if (status === 'open') {
          const ids = FHIRAppointments.map(app => app.id)
          token = createToken(ids, 'doctor')
        }
      }

      let appointments = [] as IAppointment[]
      if (!status) appointments = await Appointment.find({ doctorId: req.userId })

      res.send({ appointments: [...FHIRAppointments, ...appointments], token })
    } catch (err) {
      handleError(req, res, err)
    }
  }
)

app.post(
  '/profile/doctor/appointments',
  keycloak.protect('realm:doctor'),
  body('type').isIn(['PrivateEvent']),
  body('name').isString(),
  body(['start', 'end']).isISO8601(),
  body('description').isString().optional(),
  async (req, res) => {
    if (!validate(req, res)) return
    if (!req.userId) return res.sendStatus(500)

    const { type, name, start, end, description } = req.body

    try {
      const appointment = await Appointment.create({ type, name, start, end, description, doctorId: req.userId })
      res.send(appointment)
    } catch (err) {
      handleError(req, res, err)
    }
  }
)

app.get('/profile/doctor/appointments/:id', keycloak.protect('realm:doctor'), async (req, res) => {
  const { id } = req.params

  try {
    const { data: FHIRAppointment } = await axios.get<iHub.Appointment>(
      `/profile/doctor/appointments/${id}?include=patient`,
      {
        headers: { Authorization: `Bearer ${getAccessToken(req)}` },
      }
    )

    const coreAppointment = await CoreAppointment.findOne({ id })
    if (!coreAppointment) throw new Error(`Core Appointment must exist but not found for ID: ${id}!`)

    let appointment
    const minutes = differenceInMinutes(parseISO(FHIRAppointment.start as any), Date.now())
    if (minutes < 15 && coreAppointment.status === 'upcoming') {
      appointment = { ...FHIRAppointment, type: 'Appointment', status: 'open' }
    } else {
      appointment = { ...FHIRAppointment, type: 'Appointment', status: coreAppointment.status }
    }

    let token = ''
    if (appointment.status === 'open') token = createToken([appointment.id], 'doctor')

    res.send({ ...appointment, token })
  } catch (err) {
    handleError(req, res, err)
  }
})

app.post(
  '/profile/doctor/appointments/:id',
  keycloak.protect('realm:doctor'),
  param('id').isString(),
  body('status').isIn(['closed', 'open']),
  async (req, res) => {
    if (!validate(req, res)) return

    const { status } = req.body
    const { id } = req.params

    try {
      // Get Appointment and check for access rights
      const req1 = axios.get<iHub.Appointment>(`/profile/doctor/appointments/${id}`, {
        headers: { Authorization: `Bearer ${getAccessToken(req)}` },
      })
      const req2 = axios.get<iHub.Appointment>(`/profile/doctor`, {
        headers: { Authorization: `Bearer ${getAccessToken(req)}` },
      })
      const [resp, respp] = await Promise.all([req1, req2])

      if (resp.data.doctorId !== respp.data.id) return res.sendStatus(403)

      let appointment = await CoreAppointment.findOne({ id })
      if (!appointment) throw new Error(`Core Appointment must exist but not found for ID: ${id}!`)

      if (appointment.status === 'locked') return res.status(400).send({ message: 'Appointment locked' })

      const update = await CoreAppointment.updateOne({ id }, { status })
      if (update.nModified !== 1) return res.status(400).send({ message: 'Update not successful' })

      res.sendStatus(200)
    } catch (err) {
      handleError(req, res, err)
    }
  }
)

app.delete('/profile/doctor/appointments/:id', keycloak.protect('realm:doctor'), async (req, res) => {
  try {
    await Appointment.deleteOne({ _id: req.params.id, doctorId: req.userId })
    res.sendStatus(200)
  } catch (err) {
    handleError(req, res, err)
  }
})

//
// APPOINTMENTS for PATIENTS:
// Protected Routes for managing profile information
// GET /profile/patient/appointments - Read appointments of Patient
// POST /profile/patient/appointments - Create appointment for Patient
//

app.get('/profile/patient/appointments', keycloak.protect('realm:patient'), async (req, res) => {
  try {
    const { data } = await axios.get<iHub.Appointment[]>('/profile/patient/appointments?include=doctor', {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })

    const ids = data.map(app => app.id)
    const coreAppointments = await CoreAppointment.find({ id: { $in: ids } })

    const FHIRAppointments = coreAppointments.map(appointment => {
      const FHIRAppointment = data.find(app => app.id === appointment.id)
      if (!FHIRAppointment) throw new Error(`FHIR Appointment must exist but not found for ID: ${appointment.id}!`)

      const minutes = differenceInMinutes(parseISO(FHIRAppointment.start as any), Date.now())
      if (minutes < 15 && appointment.status === 'upcoming') {
        return { ...FHIRAppointment, type: 'Appointment', status: 'open' }
      } else {
        return { ...FHIRAppointment, type: 'Appointment', status: appointment.status }
      }
    })

    res.send({ appointments: FHIRAppointments, token: '' })
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/patient/appointments/:id', keycloak.protect('realm:patient'), async (req, res) => {
  const { id } = req.params

  try {
    const { data: FHIRAppointment } = await axios.get<iHub.Appointment>(
      `/profile/patient/appointments/${id}?include=doctor`,
      {
        headers: { Authorization: `Bearer ${getAccessToken(req)}` },
      }
    )

    const coreAppointment = await CoreAppointment.findOne({ id })
    if (!coreAppointment) throw new Error(`Core Appointment must exist but not found for ID: ${id}!`)

    let appointment
    const minutes = differenceInMinutes(parseISO(FHIRAppointment.start as any), Date.now())
    if (minutes < 15 && coreAppointment.status === 'upcoming') {
      appointment = { ...FHIRAppointment, type: 'Appointment', status: 'open' }
    } else {
      appointment = { ...FHIRAppointment, type: 'Appointment', status: coreAppointment.status }
    }

    let token = ''
    if (appointment.status === 'open') token = createToken([appointment.id], 'patient')

    res.send({ ...appointment, token })
  } catch (err) {
    handleError(req, res, err)
  }
})

app.post(
  '/profile/patient/appointments',
  keycloak.protect('realm:patient'),
  body('doctorId').isString(),
  body('start').isISO8601(),
  async (req, res) => {
    if (!validate(req, res)) return

    const { start, doctorId } = req.body

    const startDate = new Date(start)
    const endDate = new Date(start)
    endDate.setMilliseconds(endDate.getMilliseconds() + APPOINTMENT_LENGTH)

    const now = new Date()
    now.setMilliseconds(now.getMilliseconds() + APPOINTMENT_LENGTH)
    if (startDate < now) return res.status(400).send({ message: "'start' has to be at least 30 minutes in the future" })

    try {
      const availabilities = await calculateAvailability(doctorId, startDate, endDate)
      const available = availabilities.map(date => Date.parse(date)).includes(Date.parse(start))
      if (!available) return res.status(400).send({ message: 'timeslot is not available for booking' })

      const appointment = await CoreAppointment.create({ date: startDate, status: 'upcoming', id: '_' })

      const resp = await axios.post(
        '/profile/patient/appointments',
        { doctorId, start, end: endDate.toISOString() },
        {
          headers: { Authorization: `Bearer ${getAccessToken(req)}` },
        }
      )
      const x = await CoreAppointment.findByIdAndUpdate(appointment._id, { $set: { id: resp.data.id } })

      // FIXME: double check for double booking
      res.send(resp.data)
    } catch (err) {
      handleError(req, res, err)
    }
  }
)

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

    const resp = await axios.get<{ items: iHub.Doctor[]; total: number }>(
      `/doctors${queryString ? `?${queryString}` : ''}`
    )

    // FIXME: this currently creates one worker per doctor with huge overhead.
    // Probably best to move this into a own worker.

    const doctorsWithNextAvailability = await Promise.all(
      resp.data.items.map(async doctor => ({
        ...doctor,
        nextAvailability: await calculateNextAvailability(doctor.id),
      }))
    )

    res.send({ items: doctorsWithNextAvailability, total: resp.data.total })
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/doctors/:id', async (req, res) => {
  try {
    const resp = await axios.get<iHub.Doctor>(`/doctors/${req.params.id}`)
    res.send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get(
  '/doctors/:id/availability',
  param('id').isString(),
  query(['start', 'end']).isISO8601(),
  async (req: express.Request, res: express.Response) => {
    if (!validate(req, res)) return

    const { start, end } = req.query
    const { id: doctorId } = req.params

    try {
      let startDate = new Date(start as string)
      let endDate = new Date(end as string)

      const now = new Date()
      now.setMilliseconds(now.getMilliseconds() + APPOINTMENT_LENGTH)

      if (startDate < now) startDate = now
      if (endDate < startDate)
        return res.status(400).send({ message: 'End Date has to be larger than start and in the future' })

      if (differenceInDays(endDate, startDate) > 30) {
        endDate = new Date(startDate)
        endDate.setDate(endDate.getDate() + 31)
      }

      const availabilities = await calculateAvailability(doctorId, startDate, endDate)

      const nextAvailability = await calculateNextAvailability(doctorId)

      // FIXME: nextAvailability is runing the whole loop again.
      // Could be done in one loop in the case that start = now
      // Also starts two workers. Could start one
      res.send({ availabilities, nextAvailability })
    } catch (err) {
      handleError(req, res, err)
    }
  }
)

//
// Utils:
// GET /presigned - List doctor specializations
//

app.get('/presigned', keycloak.protect(), async (req, res) => {
  try {
    const resp = await axios.get('/s3/presigned', { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

//
// OTHER:
// GET /specializations - List doctor specializations
//

app.get('/specializations', async (req, res) => {
  try {
    const resp = await axios.get('/specializations')
    res.send(resp.data)
  } catch (err) {
    handleError(req, res, err)
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
