import 'dotenv/config'

require('elastic-apm-node').start({
  serviceName: 'boldo-server',
  secretToken: process.env.APM_SERVER_SECRET,
  serverUrl: process.env.APM_SERVER_URL,
  environment: process.env.APM_SERVER_ENVIRONMENT
});

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
  APPOINTMENT_WAIT_RESERVATION_LENGTH,
  calculateNextAvailability,
  createToken,
  filterByAppointmentAvailability as filterByTypeOfAvailability,
  doctorAvailability,
  getDoctorsWithAvailability
} from './util/helpers'

import {genericQueryParamsMaker} from "./util/utils";

import { archiveAppointments } from './scripts/archiveAppointments'

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
// GET /profile/doctor/organizations - list the organizations the doctor is associated with
//

app.get('/profile/doctor', keycloak.protect('realm:doctor'), async (req, res) => {
  try {
    const doctor = await Doctor.findById(req.userId)
    const blocks = doctor?.blocks || [];
    console.log(`Bearer ${getAccessToken(req)}`)
    const resp = await axios.get('/profile/doctor', { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    const organization = await axios.get('/profile/doctor/organizations', { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })

    res.send({ ...resp.data, workspace: organization.data, blocks, new: !doctor })
  } catch (err) {
    console.log(err)
    handleError(req, res, err)
  }
})

app.put(
  '/profile/doctor',
  keycloak.protect('realm:doctor'),
  body([
    'blocks',
    'blocks.*.openHours.mon',
    'blocks.*.openHours.tue',
    'blocks.*.openHours.wed',
    'blocks.*.openHours.thu',
    'blocks.*.openHours.fri',
    'blocks.*.openHours.sat',
    'blocks.*.openHours.sun',
  ]).isArray(),
  body(['openHours.*.*.start', 'openHours.*.*.end']).isInt().toInt(),
  async (req, res) => {
    if (!validate(req, res)) return

    const { blocks, ...ihubPayload } = req.body
    let update = true;
    if (blocks.length > 1) {
      const dayOfTheWeek = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
      for(var index = 0; index < blocks.length; index++) {
        //openHour configuration of the current organization
        const openHours = blocks[index].openHours;
        for (var j = 0; j < dayOfTheWeek.length; j++) {
          const openHoursOfDay = openHours[dayOfTheWeek[j]];
          for (var k = 0; k < openHoursOfDay.length; k++) {
            const hour = openHoursOfDay[k];
            for(var i = index+1; i < blocks.length; i++) {
              //openHour configuration of the next organization
              const openHoursOrgNext = blocks[i].openHours[dayOfTheWeek[j]];
              //openHours configuration overlay control
              const result = openHoursOrgNext.find((orgNext: any) =>
                (orgNext.start == hour.start ||
                (orgNext.start < hour.start && orgNext.end > hour.start) ||
                (orgNext.start > hour.start && orgNext.start < hour.end)) ||
                (orgNext.start > hour.start && orgNext.end <= hour.end)
              )
              if (result) {
                update = false;
                handleError(req, res, { status: 400, message: "openHours settings overlay between organizations " + blocks[index].idOrganization + " and " + blocks[i].idOrganization });
                return;
              }             
            }

            //overlay control between appointment type
            if (openHoursOfDay.length > 1) {
              for(var l = k+1; l < openHoursOfDay.length; l++) {             
                const hourNext = openHoursOfDay[l];
                if (
                  (hourNext.start == hour.start && hourNext.appointmentType == hour.appointmentType) ||
                  (hourNext.start == hour.start && (hourNext.appointmentType.includes(hour.appointmentType) || hour.appointmentType.includes(hourNext.appointmentType))) ||
                  (hourNext.start < hour.start && hourNext.end > hour.start && (hourNext.appointmentType.includes(hour.appointmentType) || hour.appointmentType.includes(hourNext.appointmentType))) ||
                  (hourNext.start > hour.start && hourNext.start < hour.end && (hourNext.appointmentType.includes(hour.appointmentType) || hour.appointmentType.includes(hourNext.appointmentType))) ||
                  (hourNext.start > hour.start && hourNext.end <= hour.end && (hourNext.appointmentType.includes(hour.appointmentType) || hour.appointmentType.includes(hourNext.appointmentType)))
                ) {
                  update = false;
                  handleError(req, res, { status: 400, message: "openHours setting overlay between appointment types for " + dayOfTheWeek[j] + " in organization " + blocks[index].idOrganization});
                  return;
                }               
              }
            } 
          }
        }  
      };
    }

    try {
      if (update) {
        //get all doctor workspaces
        const organization = await axios.get('/profile/doctor/organizations', { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
        // validations and controls
        if (organization.data) {
          let isSuscribed = false;
          blocks.forEach((element: any) => {
            isSuscribed = organization.data.some((org: any) => org.id == element.idOrganization)
            if (!isSuscribed) {
              update = false;
              res.status(400).send({ message: "The doctor has no workspace: "+element.idOrganization });
            }
          });
        } else {
          update = false;
          res.status(400).send({ message: "The doctor has no workspace" });
        }

        if (update) {
          const resp = await axios.get('/profile/doctor', { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
          await Doctor.findOneAndUpdate({ _id: req.userId, id: resp.data.id }, { blocks } ,{ upsert: true, runValidators: true })
          await axios.put('/profile/doctor', ihubPayload, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
          res.sendStatus(200)
        }
      }
    } catch (err) {
      handleError(req, res, err)
    }
  }
)

app.get('/profile/doctor/organizations', keycloak.protect('realm:doctor'), async (req, res) => {
  if (!validate(req, res)) return
  try {
    const resp = await axios.get(`/profile/doctor/organizations`,
      { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

//
// RELATED ENCOUNTERS
// Manage encounters what were linked among them through the same reason encounter
// GET /profile/doctor/relatedEncounters/Patient/:id - Get all related encounters from a single patient. List the groups.
// GET /profile/doctor/relatedEncounters/${id} - Get a single group of related encounters. The ID may from anyone in the group 
// GET /profile/doctor/patient/:patientId/encounters - Get all encounter by patientId
// GET /profile/doctor/patient/:patientId/encounters-v2 - Get all encounter by patientId from ElasticSearch server
// GET /profile/doctor/patient/:patientId/encounters/:encounterId - Get summary encounter by id
// POST /profile/doctor/patient/:patientId/report - Report patient with suspicious false identity

//TODO: correct the path 
app.get('/profile/doctor/relatedEncounters/Patient/:id/filterEncounterId/:encounterId', keycloak.protect('realm:doctor'), async (req, res) => {
  if (!validate(req, res)) return
  const { id, encounterId } = req.params
  try {
    const response = await axios.get(`/profile/doctor/relatedEncounters/Patient/${id}?lastOnly=true&filterEncounterId=${encounterId}`, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.send({ encounter: response.data })
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/doctor/relatedEncounters/:id', keycloak.protect('realm:doctor'), async (req, res) => {
  if (!validate(req, res)) return
  const { id, encounterId } = req.params
  try {
    const response = await axios.get(`/profile/doctor/relatedEncounters/${id}?includePrescriptions=false&includeSoep=true`, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.send({ encounter: response.data })
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/doctor/patient/:patientId/encounters', keycloak.protect('realm:doctor'), async (req, res) => {
  if (!validate(req, res)) return;
  const { patientId } = req.params;
  const { doctorId, content, privateComments, count, offset, order } = req.query as any;
  var query = [
    { key: "doctorId", value: doctorId },
    { key: "content", value: content },
    { key: "privateComments", value: privateComments },
    { key: "count", value: count },
    { key: "offset", value: offset },
    { key: "order", value: order }
  ]
  console.log(query);
  var queryParams = "";
  if (doctorId || content || privateComments || count || offset || order) {
    queryParams = "?";
  }
  query.forEach(element => {
    if (element.value) {
      queryParams = queryParams + `${element.key}=${element.value}&`
    }
  });
  const path = `/profile/doctor/patient/${patientId}/encounters${queryParams}`
  console.log(path)
  try {
    const response = await axios.get(path, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.send(response.data)
  } catch (err) {
    handleError(req, res, err)
  }
});

app.get('/profile/doctor/patient/:patientId/encounters-v2', keycloak.protect('realm:doctor'), async (req, res) => {
  if (!validate(req, res)) return;
  const { patientId } = req.params;
  const { doctorId, content, count, offset, order } = req.query as any;
  var query = [
    { key: "doctorId", value: doctorId },
    { key: "content", value: content },
    { key: "count", value: count },
    { key: "offset", value: offset },
    { key: "order", value: order }
  ]

  var queryParams = "?";
  query.forEach(element => {
    if (element.value) {
      queryParams = queryParams + `${element.key}=${element.value}&`
    }
  });
  const path = `/profile/doctor/patient/${patientId}/encounters-v2${queryParams}`
  try {
    const response = await axios.get(path, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.send(response.data)
  } catch (err) {
    handleError(req, res, err)
  }
});


app.get('/profile/doctor/patient/:patientId/encounters/:encounterId', keycloak.protect('realm:doctor'), async (req, res) => {
  if (!validate(req, res)) return
  const { patientId, encounterId } = req.params
  try {
    const response = await axios.get(`/profile/doctor/patient/${patientId}/encounters/${encounterId}`, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.send(response.data)
  } catch (err) {
    handleError(req, res, err)
  }
});

app.get('/profile/doctor/patient/:patientId/encounter/:encounterId/studyOrders', keycloak.protect('realm:doctor'), async (req, res) => {
  if (!validate(req, res)) return
  const { patientId, encounterId } = req.params
  try {
    const response = await axios.get(`/profile/doctor/patient/${patientId}/encounter/${encounterId}/studyOrders`, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.send(response.data)
  } catch (err) {
    handleError(req, res, err)
  }
});

app.post('/profile/doctor/patient/:patientId/report', keycloak.protect('realm:doctor'), async (req, res) => {
  const payload = req.body
  const { patientId } = req.params
  try {
    const resp =  await axios.post(`profile/doctor/patient/${patientId}/report?`, payload, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

//
// MANAGE Patient activation:
// Routes for managing activation & patient from profile Doctor
// POST /profile/doctor/validatePatient - Validates an specific patient
// GET /profile/doctor/inactivePatients - List inactive Patients 
//

//TODO: delete DEPRECATED ENDPOINT
app.post('/user/validate', keycloak.protect('realm:doctor'), async (req, res) => {
  const payload = req.body
  try {
    const resp =  await axios.put(`profile/doctor/validatePatient?username=${payload.username}`, payload, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

//TODO: delete comment. This endpoint is the same as the one above but with corrected path and operation
app.put('/profile/doctor/validatePatient', query('username').notEmpty(), keycloak.protect('realm:doctor'), async (req, res) => {
  const payload = req.body
  try {
    const resp =  await axios.put(`profile/doctor/validatePatient?username=${req.query.username}`, payload,{
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

//TODO: delete DEPRECATED endpoint.
app.get('/inactive', keycloak.protect('realm:doctor'), async (req, res) => {
  try {
    const resp = await axios.get('/profile/doctor/inactivePatients', {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.send({ ...resp.data })
  } catch (err) {
    console.log(err)
    handleError(req, res, err)
  }
})

//TODO: This endpoint is the same as the one above but with fixed path
app.get('/profile/doctor/inactivePatients', keycloak.protect('realm:doctor'), async (req, res) => {
  try {
    const resp = await axios.get('/profile/doctor/inactivePatients', {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.send({ ...resp.data })
  } catch (err) {
    handleError(req, res, err)
  }
})


//
// PRIVATE COMMENTS:
// Routes for managins private comments for Doctors
// GET /profile/doctor/relatedEncounters/:id/privateComments - List a private comment from a group of related encounters
// POST /profile/doctor/encounters/:id/privateComments - Create a new private comment within an encounter
// PUT /profile/doctor/encounters/:encounterId/privateComments/:privateCommentId - Update a private comment from an encounter
// DELETE /profile/doctor/encounters/:encounterId/privateComments/:privateCommentId - Delete a private comment from an encounter
// 


app.get('/profile/doctor/relatedEncounters/:id/privateComments', keycloak.protect('realm:doctor'), async (req, res) => {
  if (!validate(req, res)) return
  const { id} = req.params
  try {
    const response = await axios.get(`/profile/doctor/relatedEncounters/${id}/privateComments`, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.send({ encounter: response.data })
  } catch (err) {
    handleError(req, res, err)
  }
})

app.post('/profile/doctor/encounters/:id/privateComments', keycloak.protect('realm:doctor'), async (req, res) => {
  const payload = req.body
  const { id } = req.params
  try {
    const resp =  await axios.post(`/profile/doctor/encounters/${id}/privateComments`, payload, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.send(resp.data)
  } catch (err) {
    res.send(err)
    handleError(req, res, err)
  }
})

app.put('/profile/doctor/encounters/:encounterId/privateComments/:privateCommentId', keycloak.protect('realm:doctor'), async (req, res) => {
  if (!validate(req, res)) return
  const { encounterId,privateCommentId } = req.params
  const payload = req.body
  try {
    const response = await axios.put(`/profile/doctor/encounters/${encounterId}/privateComments/${privateCommentId}`, payload, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.send({ encounter: response.data })
  } catch (err) {
    handleError(req, res, err)
  }
})

app.delete(
  '/profile/doctor/encounters/:encounterId/privateComments/:privateCommentId',
  keycloak.protect('realm:doctor'),
  async (req, res) => {
    try {
      const { encounterId, privateCommentId } = req.params

      const headers = {
        Authorization: `Bearer ${getAccessToken(req)}`,
      }

      const response = await axios.delete(
        `/profile/doctor/encounters/${encounterId}/privateComments/${privateCommentId}`,
        { headers }
      )

      res.send(response.data)
    } catch (err) {
      handleError(req, res, err)
    }
  }
)

//
// MANAGE Patient diagnostic reports:
// Routes for managing patient diagnostic reports
// GET /profile/doctor/diagnosticReports - List Patient's diagnostic reports 
// GET /profile/doctor/diagnosticReport/:id - get a diagnostic report
// POST /profile/doctor/diagnosticReport - create a patient diagnostic report
app.get('/profile/doctor/diagnosticReports', keycloak.protect('realm:doctor'), async (req, res) => {
  if (!validate(req, res)) return
  try {
    console.log(`/profile/doctor/diagnosticReports?patient_id=${req.query.patient_id}${req.query.page ? `&page=${req.query.page}` : ''}${req.query.count ? `&count=${req.query.count}` : ''}${req.query.category ? `&category=${req.query.category}` : ''}${req.query.dateOrder ? `&dateOrder=${req.query.dateOrder}` : ''}`)
    const resp = await axios.get(`/profile/doctor/diagnosticReports?patient_id=${req.query.patient_id}${req.query.page ? `&page=${req.query.page}` : ''}${req.query.count ? `&count=${req.query.count}` : ''}${req.query.category ? `&category=${req.query.category}` : ''}${req.query.dateOrder ? `&dateOrder=${req.query.dateOrder}` : ''}`,
      { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/doctor/diagnosticReport/:id', keycloak.protect('realm:doctor'), async (req, res) => {
  const { id } = req.params
  try {
    const resp = await axios.get(`/profile/doctor/diagnosticReport/${id}`,
      { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.post('/profile/doctor/diagnosticReport', keycloak.protect('realm:doctor'), async (req, res) => {
  const payload = req.body
  const startDate = new Date(payload.effectiveDate)
  if (startDate > new Date()) return res.status(400).send({ message: "invalid effectiveDate" })
  try {
    const resp = await axios.post('/profile/doctor/diagnosticReport', payload, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

//
// MANAGE Patient service request from doctor profile:
// Routes for managing patient service request
// POST /profile/doctor/serviceRequest - create a list of Patient's service requests 
// POST /profile/doctor/studyOrderTemplate - create a a study order template
// GET /profile/doctor/studyOrderTemplate - obtaint a list of study order templates
// PUT /profile/doctor/studyOrderTemplate/:id - update a a study order template
// PUT /profile/doctor/studyOrderTemplate/inactivate/:id - inactivate a study order template

app.post('/profile/doctor/serviceRequest', keycloak.protect('realm:doctor'), async (req, res) => {
  const payload = req.body
  try {
    const resp =  await axios.post('/profile/doctor/serviceRequest', payload, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.post('/profile/doctor/studyOrderTemplate', keycloak.protect('realm:doctor'), async (req, res) => {
  const payload = req.body
  try {
    const resp =  await axios.post('/profile/doctor/studyOrderTemplate', payload, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/doctor/studyOrderTemplate', keycloak.protect('realm:doctor'), async (req, res) => {
  try {
    const resp = await axios.get(`/profile/doctor/studyOrderTemplate`,
      { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.put('/profile/doctor/studyOrderTemplate/:id', keycloak.protect('realm:doctor'), async (req, res) => {
  const { id } = req.params
  const payload = req.body
  try {
    const resp = await axios.put(`/profile/doctor/studyOrderTemplate/${id}`, payload, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.put('/profile/doctor/studyOrderTemplate/inactivate/:id', keycloak.protect('realm:doctor'), async (req, res) => {
  const { id } = req.params
  const payload = req.body
  try {
    const resp = await axios.put(`/profile/doctor/studyOrderTemplate/inactivate/${id}`, payload, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/doctor/serviceRequest/:id', keycloak.protect('realm:doctor'), async (req, res) => {
  const { id } = req.params
  try {
    const resp = await axios.get(`/profile/doctor/serviceRequest/${id}`, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/doctor/serviceRequests', keycloak.protect('realm:doctor'), async (req, res) => {
  if (!validate(req, res)) return
  try {
    console.log(`/profile/doctor/serviceRequests?patient_id=${req.query.patient_id}${req.query.page ? `&page=${req.query.page}` : ''}${req.query.count ? `&count=${req.query.count}` : ''}${req.query.category ? `&category=${req.query.category}` : ''}${req.query.dateOrder ? `&dateOrder=${req.query.dateOrder}` : ''}`)
    const resp = await axios.get(`/profile/doctor/serviceRequests?patient_id=${req.query.patient_id}${req.query.page ? `&page=${req.query.page}` : ''}${req.query.count ? `&count=${req.query.count}` : ''}${req.query.category ? `&category=${req.query.category}` : ''}${req.query.dateOrder ? `&dateOrder=${req.query.dateOrder}` : ''}${req.query.orderNumber ? `&orderNumber=${req.query.orderNumber}` : ''}`,
      { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/doctor/studyOrders', keycloak.protect('realm:doctor'), async (req, res) => {
  if (!validate(req, res)) return
  try {
    const resp = await axios.get(`/profile/doctor/studyOrders?patient_id=${req.query.patient_id}${req.query.category ? `&category=${req.query.category}` : ''}${req.query.description ? `&description=${req.query.description}` : ''}${req.query.orderNumber ? `&orderNumber=${req.query.orderNumber}` : ''}${req.query.withResult ? `&withResult=${req.query.withResult}` : ''}${req.query.newFirst ? `&newFirst=${req.query.newFirst}` : ''}${req.query.count ? `&count=${req.query.count}` : ''}${req.query.page ? `&page=${req.query.page}` : ''}${req.query.currentDoctorOnly ? `&currentDoctorOnly=${req.query.currentDoctorOnly}` : ''}`,
      { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/doctor/studyResults', keycloak.protect('realm:doctor'), async (req, res) => {
  if (!validate(req, res)) return
  try {
    const resp = await axios.get(`/profile/doctor/studyResults?patient_id=${req.query.patient_id}${req.query.category ? `&category=${req.query.category}` : ''}${req.query.description ? `&description=${req.query.description}` : ''}${req.query.orderNumber ? `&orderNumber=${req.query.orderNumber}` : ''}${req.query.withOrder ? `&withOrder=${req.query.withOrder}` : ''}${req.query.newFirst ? `&newFirst=${req.query.newFirst}` : ''}${req.query.count ? `&count=${req.query.count}` : ''}${req.query.page ? `&page=${req.query.page}` : ''}${req.query.currentDoctorOnly ? `&currentDoctorOnly=${req.query.currentDoctorOnly}` : ''}`,
      { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})
//
// MANAGE Service request from patient profile:
// Routes for managing patient service request
// GET /profile/patient/serviceRequests - obtaint a list of study order group by encounter
// GET /profile/patient/encounter/:id/serviceRequests - obtaint a list of study order for an encounter
// GET /profile/patient/serviceRequest/:id - obtaint a study order by id
// GET /profile/patient/serviceRequest/reports?ids=[list ids] - Prints OrderStudy by a list of Ids
// GET /profile/patient/prescriptions/reports?ids=[list encounter ids] - Prints prescriptions instructions

app.get('/profile/patient/serviceRequests', keycloak.protect('realm:patient'), async (req, res) => {
  try {
    const resp = await axios.get('/profile/patient/serviceRequests', { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/patient/encounter/:id/serviceRequests', keycloak.protect('realm:patient'), async (req, res) => {
  const { id } = req.params
  try {
    const resp = await axios.get(`/profile/patient/encounter/${id}/serviceRequests`, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/patient/serviceRequest/:id', keycloak.protect('realm:patient'), async (req, res) => {
  const { id } = req.params
  try {
    const resp = await axios.get(`/profile/patient/serviceRequest/${id}`, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/patient/serviceRequests/reports',
    cors({ origin: AllowedOrigins, credentials: true, exposedHeaders:['Content-Disposition'] }),
    keycloak.protect('realm:patient'), async (req, res) => {
      if (!validate(req, res)) return

      let reportsParam = genericQueryParamsMaker(req.query)

      try {
        const response = await axios.get(`/profile/patient/serviceRequests/reports?${reportsParam? `${reportsParam}`: ''}`, {
          responseType: 'arraybuffer',
          headers: {
            Authorization: `Bearer ${getAccessToken(req)}`,
            'Content-Type': 'application/json',
            'Accept': 'application/pdf'
          },
        })

        if (response.status===200){ //There's a PDF in the buffer
          let filename = response.headers['content-disposition']?
              response.headers['content-disposition'].split('filename="')[1].split('.')[0]:'consulta' //obtains file name from header if exist

          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `attachment; filename=${filename}.pdf`);
          res.setHeader('Content-Length', response.data.length)
          res.end(response.data)
        }else{ // Other error codes: 204, 403, 404, 500
          res.sendStatus(response.status);
        }
      } catch (err) {
        handleError(req, res, err)
      }
    })

app.get('/profile/patient/prescriptions/reports',
    cors({ origin: AllowedOrigins, credentials: true, exposedHeaders:['Content-Disposition'] }),
    keycloak.protect('realm:patient'), async (req, res) => {
      if (!validate(req, res)) return

      let reportsParam = genericQueryParamsMaker(req.query)

      try {
        const response = await axios.get(`/profile/patient/prescriptions/reports?${reportsParam? `${reportsParam}`: ''}`, {
          responseType: 'arraybuffer',
          headers: {
            Authorization: `Bearer ${getAccessToken(req)}`,
            'Content-Type': 'application/json',
            'Accept': 'application/pdf'
          },
        })

        if (response.status===200){ //There's a PDF in the buffer
          let filename = response.headers['content-disposition']?
              response.headers['content-disposition'].split('filename="')[1].split('.')[0]:'consulta' //obtains file name from header if exist

          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `attachment; filename=${filename}.pdf`);
          res.setHeader('Content-Length', response.data.length)
          res.end(response.data)
        }else{ // Other error codes: 204, 403, 404, 500
          res.sendStatus(response.status);
        }
      } catch (err) {
        handleError(req, res, err)
      }
    })


// MANAGE Service request from patient caretaker profile:
// Routes for managing dependent patient  service request
// GET /profile/caretaker/dependent/:idDependent/serviceRequests - obtains a list of study order group by encounter
// GET /profile/caretaker/dependent/:idDependent/encounter/:id/serviceRequests - obtains a list of study order for an encounter
// GET /profile/caretaker/dependent/:idDependent/serviceRequest/:id - obtains a study order by id
// GET /profile/caretaker/dependent/:idDependent/serviceRequest/reports?ids=[list ids] - Prints OrderStudy from Dependent
// GET /profile/caretaker/dependent/:idDependent/prescriptions/reports?ids=[list encounter ids] - Prints prescriptions instructions from Dependent

app.get('/profile/caretaker/dependent/:idDependent/serviceRequests', keycloak.protect('realm:patient'), async (req, res) => {
  const { idDependent } = req.params
  try {
    const resp = await axios.get(`/profile/caretaker/dependent/${idDependent}/serviceRequests`, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/caretaker/dependent/:idDependent/encounter/:id/serviceRequests', keycloak.protect('realm:patient'), async (req, res) => {
  const { idDependent, id } = req.params
  try {
    const resp = await axios.get(`/profile/caretaker/dependent/${idDependent}/encounter/${id}/serviceRequests`, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/caretaker/dependent/:idDependent/serviceRequest/:id', keycloak.protect('realm:patient'), async (req, res) => {
  const { idDependent, id } = req.params
  try {
    const resp = await axios.get(`/profile/caretaker/dependent/${idDependent}/serviceRequest/${id}`, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/caretaker/dependent/:idDependent/serviceRequests/reports',
    cors({ origin: AllowedOrigins, credentials: true, exposedHeaders:['Content-Disposition'] }),
    keycloak.protect('realm:patient'), async (req, res) => {
      const { idDependent } = req.params
      if (!validate(req, res)) return

      let reportsParam = genericQueryParamsMaker(req.query)

      try {
        const response = await axios.get(`/profile/caretaker/dependent/${idDependent}/serviceRequests/reports?${reportsParam? `${reportsParam}`: ''}`, {
          responseType: 'arraybuffer',
          headers: {
            Authorization: `Bearer ${getAccessToken(req)}`,
            'Content-Type': 'application/json',
            'Accept': 'application/pdf'
          },
        })

        if (response.status===200){ //There's a PDF in the buffer
          let filename = response.headers['content-disposition']?
              response.headers['content-disposition'].split('filename="')[1].split('.')[0]:'consulta' //obtains file name from header if exist

          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `attachment; filename=${filename}.pdf`);
          res.setHeader('Content-Length', response.data.length)
          res.end(response.data)
        }else{ // Other error codes: 204, 403, 404, 500
          res.sendStatus(response.status);
        }
      } catch (err) {
        handleError(req, res, err)
      }
    })

app.get('/profile/caretaker/dependent/:idDependent/prescriptions/reports',
    cors({ origin: AllowedOrigins, credentials: true, exposedHeaders:['Content-Disposition'] }),
    keycloak.protect('realm:patient'), async (req, res) => {
      const { idDependent } = req.params
      if (!validate(req, res)) return

      let reportsParam = genericQueryParamsMaker(req.query)

      try {
        const response = await axios.get(`/profile/caretaker/dependent/${idDependent}/prescriptions/reports?${reportsParam? `${reportsParam}`: ''}`, {
          responseType: 'arraybuffer',
          headers: {
            Authorization: `Bearer ${getAccessToken(req)}`,
            'Content-Type': 'application/json',
            'Accept': 'application/pdf'
          },
        })

        if (response.status===200){ //There's a PDF in the buffer
          let filename = response.headers['content-disposition']?
              response.headers['content-disposition'].split('filename="')[1].split('.')[0]:'consulta' //obtains file name from header if exist

          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `attachment; filename=${filename}.pdf`);
          res.setHeader('Content-Length', response.data.length)
          res.end(response.data)
        }else{ // Other error codes: 204, 403, 404, 500
          res.sendStatus(response.status);
        }
      } catch (err) {
        handleError(req, res, err)
      }
    })


//
// PATIENT PROFILE:
// GET /profile/patient - Read patient details
// POST /profile/patient - Update patient details
// GET  /profile/patient/organizations - list of organizations to which a patient has subscribed
// POST /profile/patient/subscriptions - creates one or more patient subscription requests to organizations
// PUT /profile/patient/organizations/priorities - edits the order of priorities for viewing patient organizations
// GET /profile/patient/subscriptionRequests - list of patient subscription requests
// DELETE /profile/patient/subscriptionRequest/:id - delete a patient's subscription request in pending status
// DELETE  /profile/patient/organization/:id - delete a patient's relationship with a BMO organization

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

app.get('/profile/patient/organizations', keycloak.protect('realm:patient'), async (req, res) => {
  try {

    let allQueryParams = genericQueryParamsMaker(req.query)
    
    const resp = await axios.get(`/profile/patient/organizations?${allQueryParams? `${allQueryParams}`: ''}`, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.post('/profile/patient/subscriptions', keycloak.protect('realm:patient'), async (req, res) => {
  const payload = req.body
  const startDate = new Date(payload.effectiveDate)
  try {
    const resp = await axios.post('/profile/patient/subscriptions', payload, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.put('/profile/patient/organizations/priorities', keycloak.protect('realm:patient'), async (req, res) => {
  const payload = req.body
  try {
    const resp = await axios.put(`/profile/patient/organizations/priorities`, payload, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})
app.get('/profile/patient/lastEncounter/doctors/:idDoctor', keycloak.protect('realm:patient'), async (req, res) => {
  const { idDoctor } = req.params
  try {
    const queryString = req.query.includeDependents!=undefined?req.query.includeDependents:true;
    const resp = await axios.get(`/profile/patient/lastEncounter/doctors/${idDoctor}?includeDependents=${queryString}`,
      {
        headers: { Authorization: `Bearer ${getAccessToken(req)}` }
      }
    )
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/patient/subscriptionRequests', keycloak.protect('realm:patient'), async (req, res) => {
  try {
    const resp = await axios.get(`/profile/patient/subscriptionRequests${req.query.status ? `?status=${req.query.status}` : ''}`, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.delete(
  '/profile/patient/subscriptionRequest/:id',
  keycloak.protect('realm:patient'),
  async (req, res) => {
    try {
      const { id} = req.params
      const resp = await axios.delete(
        `/profile/patient/subscriptionRequest/${id}`,
        { headers: { Authorization: `Bearer ${getAccessToken(req)}` } }
      )

      res.status(resp.status).send(resp.data)
    } catch (err) {
      handleError(req, res, err)
    }
  }
)

app.delete(
  '/profile/patient/organization/:id',
  keycloak.protect('realm:patient'),
  async (req, res) => {
    try {
      const { id} = req.params
      const resp = await axios.delete(
        `/profile/patient/organization/${id}`,
        { headers: { Authorization: `Bearer ${getAccessToken(req)}` } }
      )

      res.status(resp.status).send(resp.data)
    } catch (err) {
      handleError(req, res, err)
    }
  }
)

//
// PATIENT PROFILE (AS DEPENDENT)
// GET /profile/patient/caretakers 
// PUT /profile/patient/inactivate/caretaker/:id
// GET /profile/caretaker/dependent/:id/organizations - list of organizations to which a dependent has subscribed
// POST /profile/caretaker/dependent/:id/subscriptions - creates one or more dependent subscription requests to organizations
// GET /profile/caretaker/dependent/:id/subscriptionRequests - list of dependent subscription requests
// DELETE /profile/caretaker/dependent/:id/subscriptionRequest/:id - delete a dependent's subscription request in pending status
// DELETE /profile/caretaker/dependent/:id/organization/:id - delete a dependent's relationship with a BMO organization

app.get('/profile/patient/caretakers', keycloak.protect('realm:patient'), async (req, res) => {
  try {
    const resp = await axios.get('/profile/patient/caretakers', { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.put('/profile/patient/inactivate/caretaker/:id', keycloak.protect('realm:patient'), async (req, res) => {
  const payload = req.body
  const { id } = req.params
  try {
    const resp = await axios.put(`/profile/patient/inactivate/caretaker/${id}`, payload, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/caretaker/dependent/:idDependent/organizations', keycloak.protect('realm:patient'), async (req, res) => {
  const { idDependent } = req.params
  try {

    let allQueryParams = genericQueryParamsMaker(req.query)

    const resp = await axios.get(`/profile/caretaker/dependent/${idDependent}/organizations?${allQueryParams ? `${allQueryParams}` : ''}`, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/caretaker/dependent/:idDependent/doctors',
  keycloak.protect('realm:patient'),
  async (req, res) => {
    const { idDependent } = req.params;
    const queryString = req.originalUrl.split('?')[1];
    const endpoint = `/profile/caretaker/dependent/${idDependent}/doctors${queryString ? `?${queryString}` : ''}`;
    await getDoctorsWithAvailability(req, res, endpoint, queryString, getAccessToken(req));
  })

app.post('/profile/caretaker/dependent/:idDependent/subscriptions', keycloak.protect('realm:patient'), async (req, res) => {
  const payload = req.body
  const { idDependent } = req.params
  try {
    const resp = await axios.post(`/profile/caretaker/dependent/${idDependent}/subscriptions`, payload, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/caretaker/dependent/:idDependent/subscriptionRequests', keycloak.protect('realm:patient'), async (req, res) => {
  try {
    const { idDependent } = req.params
    const resp = await axios.get(`/profile/caretaker/dependent/${idDependent}/subscriptionRequests${req.query.status ? `?status=${req.query.status}` : ''}`, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.delete(
  '/profile/caretaker/dependent/:idDependent/subscriptionRequest/:id',
  keycloak.protect('realm:patient'),
  async (req, res) => {
    try {
      const { idDependent, id} = req.params
      const resp = await axios.delete(
        `/profile/caretaker/dependent/${idDependent}/subscriptionRequest/${id}`,
        { headers: { Authorization: `Bearer ${getAccessToken(req)}` } }
      )

      res.status(resp.status).send(resp.data)
    } catch (err) {
      handleError(req, res, err)
    }
  }
)

app.delete(
  '/profile/caretaker/dependent/:idDependent/organization/:id',
  keycloak.protect('realm:patient'),
  async (req, res) => {
    try {
      const { idDependent, id} = req.params
      const resp = await axios.delete(
        `/profile/caretaker/dependent/${idDependent}/organization/${id}`,
        { headers: { Authorization: `Bearer ${getAccessToken(req)}` } }
      )

      res.status(resp.status).send(resp.data)
    } catch (err) {
      handleError(req, res, err)
    }
  }
)
//
// CARETAKER PROFILE:
// GET /profile/caretaker/dependents
// POST /profile/caretaker/dependent
// PUT /profile/caretaker/dependent/:id
// PUT /profile/caretaker/inactivate/dependent/:id
// GET /profile/caretaker/dependent/:id
// GET /profile/caretaker/dependent/confirm/:id
// GET /profile/caretaker/relationships
// GET /profile/caretaker/dependent/s3/validateDocument/idCardParaguay/side1/uploadPresigned
// POST /profile/caretaker/dependent/s3/validateDocument/idCardParaguay/side1/validate?hash=${hash}
// GET /profile/caretaker/dependent/s3/validateDocument/idCardParaguay/side2/uploadPresigned?hash=${hash}
// POST /profile/caretaker/dependent/s3/validateDocument/idCardParaguay/side2/validate?hash=${hash}
// GET /profile/caretaker/dependent/s4/validateSelfie/uploadPresigned?hash=${hash}
// POST /profile/caretaker/dependent/s4/validateSelfie/validate?hash=${hash}
// GET /profile/caretaker/dependent/qrcode/decode?qr=${qrCode} - Decode QR code of dependent patient
// POST /profile/caretaker/dependent/add/qrcode?qr=${qrCode} - Add dependent patient by QR code

app.get('/profile/caretaker/dependents', keycloak.protect('realm:patient'), async (req, res) => {
  try {
    const resp = await axios.get('/profile/caretaker/dependents', { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.post('/profile/caretaker/dependent', keycloak.protect('realm:patient'), async (req, res) => {
  const payload = req.body
  try {
    const resp = await axios.post('/profile/caretaker/dependent', payload, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.put('/profile/caretaker/dependent/:id', keycloak.protect('realm:patient'), async (req, res) => {
  const payload = req.body
  const { id } = req.params
  try {
    const resp = await axios.put(`/profile/caretaker/dependent/${id}`, payload, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.put('/profile/caretaker/inactivate/dependent/:id', keycloak.protect('realm:patient'), async (req, res) => {
  const payload = req.body
  const { id } = req.params
  try {
    const resp = await axios.put(`/profile/caretaker/inactivate/dependent/${id}`, payload, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/caretaker/dependent/:id', keycloak.protect('realm:patient'), async (req, res) => {
  if (!validate(req, res)) return
  const { id } = req.params

  try {
    const response = await axios.get(`/profile/caretaker/dependent/${id}`, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.status(response.status).send(response.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/caretaker/dependent/confirm/:id', keycloak.protect('realm:patient'), async (req, res) => {
  if (!validate(req, res)) return
  const { id } = req.params

  try {
    const response = await axios.get(`/profile/caretaker/dependent/confirm/${id}`, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.status(response.status).send(response.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/caretaker/relationships', keycloak.protect('realm:patient'), async (req, res) => {
  try {
    const resp = await axios.get('/profile/caretaker/relationships', { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/caretaker/dependent/s3/validateDocument/idCardParaguay/side1/uploadPresigned', query('hash').isString().optional(), keycloak.protect('realm:patient'), async (req, res) => {
  const { hash } = req.query as any
  try {
    const resp = await axios.get(`/profile/caretaker/dependent/s3/validateDocument/idCardParaguay/side1/uploadPresigned${hash ? `?hash=${hash}` : ''}`, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
});

app.post('/profile/caretaker/dependent/s3/validateDocument/idCardParaguay/side1/validate', query('hash').isString().notEmpty(), keycloak.protect('realm:patient'), async (req, res) => {
  const payload = req.body
  const { hash } = req.query as any
  try {
    const resp = await axios.post(`/profile/caretaker/dependent/s3/validateDocument/idCardParaguay/side1/validate?hash=${hash}`, payload, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
});

app.get('/profile/caretaker/dependent/s3/validateDocument/idCardParaguay/side2/uploadPresigned', query('hash').isString().notEmpty(), keycloak.protect('realm:patient'), async (req, res) => {
  const { hash } = req.query as any
  try {
    const resp = await axios.get(`/profile/caretaker/dependent/s3/validateDocument/idCardParaguay/side2/uploadPresigned?hash=${hash}`, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
});

app.post('/profile/caretaker/dependent/s3/validateDocument/idCardParaguay/side2/validate', query('hash').isString().notEmpty(), keycloak.protect('realm:patient'), async (req, res) => {
  const payload = req.body
  const { hash } = req.query as any
  try {
    const resp = await axios.post(`/profile/caretaker/dependent/s3/validateDocument/idCardParaguay/side2/validate?hash=${hash}`, payload, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
});

app.get('/profile/caretaker/dependent/s4/validateSelfie/uploadPresigned', query('hash').isString().notEmpty(), keycloak.protect('realm:patient'), async (req, res) => {
  const { hash } = req.query as any
  try {
    const resp = await axios.get(`/profile/caretaker/dependent/s4/validateSelfie/uploadPresigned?hash=${hash}`, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
});

app.post('/profile/caretaker/dependent/s4/validateSelfie/validate', query('hash').isString().notEmpty(), keycloak.protect('realm:patient'), async (req, res) => {
  const payload = req.body
  const { hash } = req.query as any
  try {
    const resp = await axios.post(`/profile/caretaker/dependent/s4/validateSelfie/validate?hash=${hash}`, payload, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
});

app.get('/profile/caretaker/dependent/qrcode/decode', query('qr').isString().notEmpty(), keycloak.protect('realm:patient'), async (req, res) => {
  const { qr } = req.query as any
  try {
    const resp = await axios.get(`/profile/caretaker/qrcode/decode?qr=${qr}`, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
});

app.post('/profile/caretaker/dependent/add/qrcode', query('qr').isString().notEmpty(), keycloak.protect('realm:patient'), async (req, res) => {
  const payload = req.body
  const { qr } = req.query as any
  try {
    const resp = await axios.post(`/profile/caretaker/dependent/add/qrcode?qr=${qr}`, payload, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
});
app.get('/profile/caretaker/dependent/:idDependent/lastEncounter/doctor/:idDoctor', keycloak.protect('realm:patient'), async (req, res) => {
  const { idDependent ,idDoctor} = req.params
  try {
    const resp = await axios.get(`/profile/caretaker/dependent/${idDependent}/lastEncounter/doctor/${idDoctor}`, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})


//
// MEDICATIONS:
//
// Protected routes for managing medications
// GET /profile/doctor//medications - Read medications
//

app.get('/profile/doctor/medications', query('content').isString().optional(), keycloak.protect('realm:doctor'), async (req: any, res) => {
  if (!validate(req, res)) return

  const { content } = req.query as any

  try {
    const resp = await axios.get(`/profile/doctor/medications${content ? `?content=${content}` : ''}`, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.send({ items: resp.data.items })
  } catch (err) {
    handleError(req, res, err)
  }
});

//
// patient's personal and family history
//
// Protected routes for managing patient's personal and family history
// GET /profile/doctor/history - Read patient personal and family history
// POST /profile/doctor/allergyIntolerance - create a new record of a detected patient allergy
// PUT /profile/doctor/allergyIntolerance/:id - performs an update on a patient's allergy status corresponding to a logical deletion
// POST /profile/doctor/condition - create a new record of a detected patient pathology
// PUT /profile/doctor/condition/:id - performs an update on a patient's condition status corresponding to a logical deletion
// POST /profile/doctor/procedure - create a new record of a detected patient procedure
// PUT /profile/doctor/procedure/:id - performs an update on a patient's procedure status corresponding to a logical deletion
// POST /profile/doctor/familyMemberHistory - create a new record of a pathology of a patient's family member
// PUT /profile/doctor/familyMemberHistory/:id - performs an update on a patient's family member history status corresponding to a logical deletion
// POST /profile/doctor/observation - create a new record of a gynecology information about patient
//

app.get('/profile/doctor/history', keycloak.protect('realm:doctor'), async (req: any, res) => {
  if (!validate(req, res)) return

  try {
    const resp = await axios.get(`/profile/doctor/history${req.query.patient_id ? `?patient_id=${req.query.patient_id}` : ''}`, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.post('/profile/doctor/allergyIntolerance', keycloak.protect('realm:doctor'), async (req, res) => {
  const payload = req.body
  
  try {
    const resp = await axios.post('/profile/doctor/allergyIntolerance', payload, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})


app.put('/profile/doctor/allergyIntolerance/:id', keycloak.protect('realm:doctor'), async (req, res) => {
  const { id } = req.params
  const payload = req.body
  try {
    const resp = await axios.put(`/profile/doctor/allergyIntolerance/${id}`, payload, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.post('/profile/doctor/condition', keycloak.protect('realm:doctor'), async (req, res) => {
  const payload = req.body
  
  try {
    const resp = await axios.post('/profile/doctor/condition', payload, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})


app.put('/profile/doctor/condition/:id', keycloak.protect('realm:doctor'), async (req, res) => {
  const { id } = req.params
  const payload = req.body
  try {
    const resp = await axios.put(`/profile/doctor/condition/${id}`, payload, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.post('/profile/doctor/procedure', keycloak.protect('realm:doctor'), async (req, res) => {
  const payload = req.body
  
  try {
    const resp = await axios.post('/profile/doctor/procedure', payload, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.put('/profile/doctor/procedure/:id', keycloak.protect('realm:doctor'), async (req, res) => {
  const { id } = req.params
  const payload = req.body
  try {
    const resp = await axios.put(`/profile/doctor/procedure/${id}`, payload, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.post('/profile/doctor/familyMemberHistory', keycloak.protect('realm:doctor'), async (req, res) => {
  const payload = req.body
  
  try {
    const resp = await axios.post('/profile/doctor/familyMemberHistory', payload, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.put('/profile/doctor/familyMemberHistory/:id', keycloak.protect('realm:doctor'), async (req, res) => {
  const { id } = req.params
  const payload = req.body
  try {
    const resp = await axios.put(`/profile/doctor/familyMemberHistory/${id}`, payload, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.post('/profile/doctor/observation', keycloak.protect('realm:doctor'), async (req, res) => {
  const payload = req.body
  
  try {
    const resp = await axios.post('/profile/doctor/observation', payload, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

//
// ENCOUNTER:
// Protected routes for managing encounters
// PUT /profile/doctor/appointments/:id/encounter - Update the encounter
// GET /profile/doctor/appointments/:id/encounter - Get the encounter
// GET /profile/doctor/appointments/:id/encounter/reports - Prints PDF reports generated in the Encounter by appointmentID
//

app.put('/profile/doctor/appointments/:id/encounter', keycloak.protect('realm:doctor'), async (req, res) => {
  if (!validate(req, res)) return
  const { id } = req.params
  const { encounterData } = req.body

  try {
    await axios.put(`/profile/doctor/appointments/${id}/encounter`, encounterData, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.sendStatus(200)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/doctor/appointments/:id/encounter', keycloak.protect('realm:doctor'), async (req, res) => {
  if (!validate(req, res)) return
  const { id } = req.params

  try {
    const response = await axios.get(`/profile/doctor/appointments/${id}/encounter`, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.send({ encounter: response.data })
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/doctor/appointments/:id/encounter/reports',
    cors({ origin: AllowedOrigins, credentials: true, exposedHeaders:['Content-Disposition'] }),
  keycloak.protect('realm:doctor'), async (req, res) => {
    if (!validate(req, res)) return
    const { id } = req.params

    let reportsParam = genericQueryParamsMaker(req.query)

    try {
      const response = await axios.get(`/profile/doctor/appointments/${id}/encounter/reports?${reportsParam? `${reportsParam}`: ''}`, {
          responseType: 'arraybuffer',
          headers: {
            Authorization: `Bearer ${getAccessToken(req)}`,
            'Content-Type': 'application/json',
            'Accept': 'application/pdf'
          },
      })

      if (response.status===200){ //There's a PDF in the buffer
        let filename = response.headers['content-disposition']?
            response.headers['content-disposition'].split('filename="')[1].split('.')[0]:'consulta' //obtains file name from header if exist

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=${filename}.pdf`);
        res.setHeader('Content-Length', response.data.length)
        res.end(response.data)
      }else{ // Other error codes: 204, 403, 404, 500
        res.sendStatus(response.status);
      }
    } catch (err) {
      handleError(req, res, err)
    }
  })

//
// Encounter on patient profile
// GET /profile/patient/appointments/{id}/encounter 
// GET /profile/patient/encounters 
// GET /profile/patient/encounters/{id} 
// GET /profile/patient/relatedEncounters/{id_encounter}  
// GET /profile/patient/relatedEncounters 

app.get('/profile/patient/appointments/:id/encounter', keycloak.protect('realm:patient'), async (req, res) => {
  if (!validate(req, res)) return
  const { id } = req.params

  try {
    const response = await axios.get(`/profile/patient/appointments/${id}/encounter`, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.send({ encounter: response.data })
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/patient/encounters', keycloak.protect('realm:patient'), async (req, res) => {
  if (!validate(req, res)) return
  try {
    const response = await axios.get(`/profile/patient/encounters?${req.query.status ? `status=${req.query.status}&` : ''}includePrescriptions=${req.query.includePrescriptions}&includeSoep=${req.query.includeSoep}`, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.send({ encounter: response.data })
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/patient/encounters/:id', keycloak.protect('realm:patient'), async (req, res) => {
  if (!validate(req, res)) return
  const { id } = req.params

  try {
    const response = await axios.get(`/profile/patient/encounters/${id}`, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.send({ encounter: response.data })
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/patient/relatedEncounters/:id', keycloak.protect('realm:patient'), async (req, res) => {
  if (!validate(req, res)) return
  const { id } = req.params

  try {
    const response = await axios.get(`/profile/patient/relatedEncounters/${id}?includePrescriptions=${req.query.includePrescriptions}&includeSoep=${req.query.includeSoep}`, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.send({ encounter: response.data })
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/patient/relatedEncounters', keycloak.protect('realm:patient'), async (req, res) => {
  if (!validate(req, res)) return

  try {
    const response = await axios.get(`/profile/patient/relatedEncounters?lastOnly=${req.query.lastOnly}&includePrescriptions=${req.query.includePrescriptions}&includeSoep=${req.query.includeSoep}`, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.send({ encounter: response.data })
  } catch (err) {
    handleError(req, res, err)
  }
})
//
// Encounter on caretaker profile
// GET /profile/caretaker/dependent/{idDependent}/appointments/{id}/encounter 
// GET /profile/caretaker/dependent/{idDependent}/encounters 
// GET /profile/caretaker/dependent/{idDependent}/encounters/{id} 
// GET /profile/caretaker/dependent/{idDependent}/relatedEncounters/{id_encounter}  
// GET /profile/caretaker/dependent/{idDependent}/relatedEncounters 
app.get('/profile/caretaker/dependent/:idDependent/appointments/:id/encounter', keycloak.protect('realm:patient'), async (req, res) => {
  if (!validate(req, res)) return
  const { idDependent,id } = req.params

  try {
    const response = await axios.get(`/profile/caretaker/dependent/${idDependent}/appointments/${id}/encounter`, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.send({ encounter: response.data })
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/caretaker/dependent/:idDependent/encounters', keycloak.protect('realm:patient'), async (req, res) => {
  if (!validate(req, res)) return
  const { idDependent } = req.params

  try {
    const response = await axios.get(`/profile/caretaker/dependent/${idDependent}/encounters?${req.query.status ? `status=${req.query.status}&` : ''}includePrescriptions=${req.query.includePrescriptions}&includeSoep=${req.query.includeSoep}`, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.send({ encounter: response.data })
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/caretaker/dependent/:idDependent/encounters/:id', keycloak.protect('realm:patient'), async (req, res) => {
  if (!validate(req, res)) return
  const { idDependent, id } = req.params

  try {
    const response = await axios.get(`/profile/caretaker/dependent/${idDependent}/encounters/${id}`, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.send({ encounter: response.data })
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/caretaker/dependent/:idDependent/relatedEncounters/:id', keycloak.protect('realm:patient'), async (req, res) => {
  if (!validate(req, res)) return
  const { idDependent, id } = req.params

  try {
    const response = await axios.get(`/profile/caretaker/dependent/${idDependent}/relatedEncounters/${id}?includePrescriptions=${req.query.includePrescriptions}&includeSoep=${req.query.includeSoep}`, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.send({ encounter: response.data })
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/caretaker/dependent/:idDependent/relatedEncounters', keycloak.protect('realm:patient'), async (req, res) => {
  if (!validate(req, res)) return
  const { idDependent} = req.params
  try {
    const response = await axios.get(`/profile/caretaker/dependent/${idDependent}/relatedEncounters?lastOnly=${req.query.lastOnly}&includePrescriptions=${req.query.includePrescriptions}&includeSoep=${req.query.includeSoep}`, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.send({ encounter: response.data })
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
// POST /profile/doctor/appointments/cancel/:id - Cancel appointment by doctor 

app.get(
  '/profile/doctor/appointments',
  keycloak.protect('realm:doctor'),
  query(['start', 'end']).isISO8601().optional(),
  query('status').isString().optional(),
  query('organizationId').isString().optional(),
  async (req, res) => {
    if (!validate(req, res)) return

    const { status, start, end, organizationId } = req.query

    try {
      const  resp  = await axios.get<iHub.Appointment[]>(
        `/profile/doctor/appointments?include=patient${start && end ? `&start=${start}&end=${end}` : ''}${organizationId ? `&organizationId=${organizationId}` : ''}`,
        {
          headers: { Authorization: `Bearer ${getAccessToken(req)}` },
        }
      )
      const { data } = resp
      if(Array.isArray(data)){
        const ids = data.map(appointment => appointment.id);
        let idsOrg: any[] = [];
        if (!organizationId) {
          const organizations = await axios.get<iHub.Organization[]>('/profile/doctor/organizations', { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
          idsOrg = organizations.data.map(org =>  org.id)
        } else {
          idsOrg.push(organizationId);
        } 
        console.log(idsOrg); 
        const coreAppointments = await CoreAppointment.find({ id: { $in: ids }, idOrganization: { $in: idsOrg } })

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
        let appointments = [] as IAppointment[];
        if (!status) {
          let newStart = new Date(start as string);
          let newEnd = new Date(end as string); 
          appointments = await Appointment.find({ doctorId: req.userId, idOrganization: { $in: idsOrg }, end: { $gt: newStart }, start: { $lt: newEnd } })        
        }
        res.status(resp.status).send({ appointments: [...FHIRAppointments, ...appointments], token })
      }else{
        res.status(resp.status).send()
      }
    } catch (err) {
      handleError(req, res, err)
    }
  }
)

app.post(
  '/profile/doctor/appointments',
  keycloak.protect('realm:doctor'),
  body('type').isIn(['PrivateEvent']),
  body('idOrganization').isString(),
  body('name').isString(),
  body(['start', 'end']).isISO8601(),
  body('description').isString().optional(),
  async (req, res) => {
    if (!validate(req, res)) return
    if (!req.userId) return res.sendStatus(500)

    const { type, idOrganization, name, start, end, description, appointmentType } = req.body
    try {
      const appointment = await Appointment.create({ appointmentType: "E", type, name, start, end, description, doctorId: req.userId, idOrganization: idOrganization })
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

async function cancelAppointment(req : express.Request,res:express.Response, role : String) {
  try {
    const resp =  await axios.post(`/profile/${role}/appointments/cancel/${req.params.id}`,{}, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    console.log("status from core-health: ", resp.status)
    await CoreAppointment.updateOne({ id: req.params.id },{status:'cancelled'})
    res.sendStatus(200)
  } catch (err) {
    handleError(req, res, err)
  }
}

app.post('/profile/doctor/appointments/cancel/:id',
  keycloak.protect('realm:doctor'),
  async (req, res) => {
  cancelAppointment(req,res,'doctor')
  })

//
// PRESCRIPTIONS for PATIENTS:
// Protected Routes for managing profile prescriptions
// GET /profile/patient/prescriptions - Read prescriptions of Patient
//
app.get('/profile/patient/prescriptions', keycloak.protect('realm:patient'), async (req, res) => {
  try {
    const { data } = await axios.get<iHub.Appointment[]>('/profile/patient/prescriptions', {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })

    res.send({ prescriptions: data })
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/patient/encounter/prescription', keycloak.protect('realm:patient'), 
async (req, res) => {
  try {
    let qParam = genericQueryParamsMaker(req.query)
    const { data } = await axios.get<any[]>(`/profile/patient/encounters/prescriptions?${qParam? `${qParam}`: ''}`, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.send(data)
  } catch (err) {
    handleError(req, res, err)
  }
})

//
// APPOINTMENTS for PATIENTS:
// Protected Routes for managing profile information
// GET /profile/patient/appointments - Read appointments of Patient
// POST /profile/patient/appointments - Create appointment for Patient
// POST /profile/patient/appointments/cancel/:id - Cancel appointment by doctor 

app.get('/profile/patient/appointments',
  keycloak.protect('realm:patient'),
  query(['start']).isISO8601(), //it is mandatory
  query(['end']).isISO8601().optional(),
  async (req, res) => {
    try {
      const { start, end } = req.query
      const { data } = await axios.get<iHub.Appointment[]>(
            `/profile/patient/appointments?start=${start}&include=doctor${end?`&end=${end}`:''}`,
        {
          headers: { Authorization: `Bearer ${getAccessToken(req)}` },
        }
      )

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
  body('appointmentType').isString(),
  body('organizationId').isString(),
  async (req, res) => {
    if (!validate(req, res)) return

    const { start, doctorId,appointmentType, organizationId } = req.body
    if (!["V","A"].includes(appointmentType)) res.status(400).send({ message: "Appointmente type must be Virtual (V) or Ambulatory (A)" })
    const startDate = new Date(start)
    const endDate = new Date(start)
    endDate.setMilliseconds(endDate.getMilliseconds() + APPOINTMENT_LENGTH)

    const now = new Date()
    now.setMilliseconds(now.getMilliseconds() + APPOINTMENT_WAIT_RESERVATION_LENGTH)
    if (startDate < now) return res.status(400).send({ message: "'start' has to be at least "+ process.env.APPOINTMENT_WAIT_RESERVATION_LENGTH +" minutes in the future" })

    try {
      const availabilities = await calculateAvailability(doctorId, organizationId, startDate, endDate, getAccessToken(req), 'main', null)
      const available = availabilities.map(av => Date.parse(av["availability"])).includes(Date.parse(start))
      if (!available) return res.status(400).send({ message: 'timeslot is not available for booking' })
      const isAppType = availabilities.filter(av => Date.parse(av["availability"]) == Date.parse(start) && av["appointmentType"].includes(appointmentType)).length > 0
      if (!isAppType) return res.status(400).send({ message: 'Wrong Appointment Type' })

      const appointment = await CoreAppointment.create({ appointmentType: appointmentType, date: startDate, status: 'upcoming', id: '_', idOrganization: organizationId })

      const resp = await axios.post(
        '/profile/patient/appointments',
        { doctorId, start, end: endDate.toISOString(),appointmentType, organizationId },
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

app.post('/profile/patient/appointments/cancel/:id',
  keycloak.protect('realm:patient'),
  async (req, res) => {
  cancelAppointment(req,res,'patient')
  })

//
// PRESCRIPTIONS for DEPENDENTS:
// Protected Routes for managing profile prescriptions
// GET /profile/caretaker/dependent/:id/prescriptions - Read prescriptions of dependent 
//

app.get('/profile/caretaker/dependent/:id/prescriptions', keycloak.protect('realm:patient'), async (req, res) => {
  const { id } = req.params
  try {
    const { data } = await axios.get<iHub.Appointment[]>(`/profile/caretaker/dependent/${id}/prescriptions`, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })

    res.send({ prescriptions: data })
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/caretaker/dependent/:id/encounter/prescription', keycloak.protect('realm:patient'), async (req, res) => {
  const { id } = req.params;
  try {
    let qParam = genericQueryParamsMaker(req.query)
    const { data } = await axios.get<any[]>(`/profile/caretaker/dependent/${id}/encounters/prescriptions?${qParam? `${qParam}`: ''}`, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })

    res.send(data)
  } catch (err) {
    handleError(req, res, err)
  }
})

//
// APPOINTMENTS for DEPENDENTS:
// Protected Routes for managing profile information
// GET /profile/caretaker/dependent/:id/appointments - Read appointments of dependent
// GET /profile/caretaker/dependent/:idDependenttments/:id/ - Read appointment by id of dependent
// POST /profile/caretaker/dependent/:id/appointments - Create appointment for dependent
// POST /profile/caretaker/appointments/cancel/:id - Cancel appointment by caretaker 

app.get('/profile/caretaker/dependent/:id/appointments', keycloak.protect('realm:patient'), async (req, res) => {
  const { id } = req.params
  try {
    const { data } = await axios.get<iHub.Appointment[]>(
      `/profile/caretaker/dependent/${id}/appointments?start=${req.query.start}&include=doctor`,
      {
        headers: { Authorization: `Bearer ${getAccessToken(req)}` },
      }
    )

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

app.get('/profile/caretaker/dependent/:idDependent/appointments/:id', keycloak.protect('realm:patient'), async (req, res) => {
  const { idDependent,id } = req.params
  try {
    const { data: FHIRAppointment } = await axios.get<iHub.Appointment>(
      `/profile/caretaker/dependent/${idDependent}/appointments/${id}?include=doctor`,
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
  '/profile/caretaker/dependent/:id/appointments',
  keycloak.protect('realm:patient'),
  body('doctorId').isString(),
  body('start').isISO8601(),
  body('appointmentType').isString(),
  body('organizationId').isString(),
  async (req, res) => {
    if (!validate(req, res)) return
    const { id } = req.params
    const { start, doctorId,appointmentType,organizationId } = req.body
    if (!["V","A"].includes(appointmentType)) res.status(400).send({ message: "Appointmente type must be Virtual (V) or Ambulatory (A)" })
    const startDate = new Date(start)
    const endDate = new Date(start)
    endDate.setMilliseconds(endDate.getMilliseconds() + APPOINTMENT_LENGTH)

    const now = new Date()
    now.setMilliseconds(now.getMilliseconds() + APPOINTMENT_WAIT_RESERVATION_LENGTH)
    if (startDate < now) return res.status(400).send({ message: "'start' has to be at least "+process.env.APPOINTMENT_WAIT_RESERVATION_LENGTH+ " minutes in the future" })

    try {
      const availabilities = await calculateAvailability(doctorId, organizationId, startDate, endDate, getAccessToken(req), 'main', id)
      const available = availabilities.map(av => Date.parse(av["availability"])).includes(Date.parse(start))
      if (!available) return res.status(400).send({ message: 'timeslot is not available for booking' })
      const isAppType = availabilities.filter(av => Date.parse(av["availability"]) == Date.parse(start) && av["appointmentType"].includes(appointmentType)).length > 0
      if (!isAppType) return res.status(400).send({ message: 'Wrong Appointment Type' })

      const appointment = await CoreAppointment.create({ appointmentType: appointmentType, date: startDate, status: 'upcoming', id: '_', idOrganization: organizationId })

      const resp = await axios.post(
        `/profile/caretaker/dependent/${id}/appointments`,
        { doctorId, start, end: endDate.toISOString(),appointmentType,organizationId },
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

app.get('/profile/caretaker/dependent/:idDependent/recent/doctors', keycloak.protect('realm:patient'), async (req, res) => {
  const queryString = req.originalUrl.split('?')[1]
  const { idDependent } = req.params
  const endpoint = `/profile/caretaker/dependent/${idDependent}/recent/doctors${queryString ? `?${queryString}` : ''}`;
  await getDoctorsWithAvailability(req, res, endpoint, queryString, getAccessToken(req));
})

app.get('/profile/caretaker/dependent/:idDependent/favorite/doctors/', keycloak.protect('realm:patient'), async (req, res) => {
  const queryString = req.originalUrl.split('?')[1]
  const { idDependent } = req.params
  const endpoint = `/profile/caretaker/dependent/${idDependent}/favorite/doctors${queryString ? `?${queryString}` : ''}`;
  await getDoctorsWithAvailability(req, res, endpoint, queryString, getAccessToken(req));
})

app.put('/profile/caretaker/dependent/:idDependent/favorite/doctor/:idDoctor', keycloak.protect('realm:patient'), async (req, res) => {
  const queryString = req.query.addFavorite!=undefined?req.query.addFavorite:true;
  try {
    const resp = await axios.put(
      `/profile/caretaker/dependent/${req.params.idDependent}/favorite/doctor/${req.params.idDoctor}?addFavorite=${queryString}`,{},
      {
        headers: { Authorization: `Bearer ${getAccessToken(req)}` }
      }
    )
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})


app.post('/profile/caretaker/appointments/cancel/:id',
  keycloak.protect('realm:patient'),
  async (req, res) => {
  cancelAppointment(req,res,'caretaker')
  })
//
// Doctor
// Public Routes for searching Doctors
// GET /doctors - Fetch and search doctors
// GET /doctors/:id - Fetch doctor details
// GET /doctors/:id/availability - Fetch doctor details
// 

app.get('/profile/patient/doctors',
  keycloak.protect('realm:patient'),
  async (req, res) => {
    const queryString = req.originalUrl.split('?')[1]
    const endpoint = `/profile/patient/doctors${queryString ? `?${queryString}` : ''}`;
    await getDoctorsWithAvailability(req, res, endpoint, queryString, getAccessToken(req));
  })

app.get('/profile/patient/doctors/:id',
  keycloak.protect('realm:patient'),
  async (req, res) => {
    try {
      const resp = await axios.get<iHub.Doctor>(
        `/profile/patient/doctors/${req.params.id}`,
        {
          headers: { Authorization: `Bearer ${getAccessToken(req)}` }
        }
      )
      res.send(resp.data)
    } catch (err) {
      handleError(req, res, err)
    }
})

app.get('/profile/patient/recent/doctors', keycloak.protect('realm:patient'), async (req, res) => {
  const queryString = req.originalUrl.split('?')[1]
  const endpoint = `/profile/patient/recent/doctors${queryString ? `?${queryString}` : ''}`;
  await getDoctorsWithAvailability(req, res, endpoint, queryString, getAccessToken(req));
})

app.get('/profile/patient/favorite/doctors/', keycloak.protect('realm:patient'), async (req, res) => {
  const queryString = req.originalUrl.split('?')[1]
  const endpoint = `/profile/patient/favorite/doctors${queryString ? `?${queryString}` : ''}`;
  await getDoctorsWithAvailability(req, res, endpoint, queryString, getAccessToken(req));
})

app.put('/profile/patient/favorite/doctor/:idDoctor', keycloak.protect('realm:patient'), async (req, res) => {
  const queryString = req.query.addFavorite!=undefined?req.query.addFavorite:true;
  try {
    const resp = await axios.put(
      `/profile/patient/favorite/doctor/${req.params.idDoctor}?addFavorite=${queryString}`,{},
      {
        headers: { Authorization: `Bearer ${getAccessToken(req)}` }
      }
    )
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get(
  '/profile/patient/doctors/:idDoctor/availability',
  keycloak.protect('realm:patient'),
  param('idDoctor').isString(),
  query('organizationIdList').isString().optional(),
  query(['start', 'end']).isISO8601(),
  query('appointmentType').isString().optional(),
  async (req: express.Request, res: express.Response) => {
    await doctorAvailability(req, res, 'main', getAccessToken(req));
  }
)

app.get(
  '/profile/caretaker/dependent/:idDependet/doctors/:idDoctor/availability',
  keycloak.protect('realm:patient'),
  param('idDependet').isString(),
  param('idDoctor').isString(),
  query('organizationIdList').isString().optional(),
  query(['start', 'end']).isISO8601(),
  query('appointmentType').isString().optional(),
  async (req: express.Request, res: express.Response) => {
    await doctorAvailability(req, res, 'dependent', getAccessToken(req));
  }
)

// DIAGNOSTIC REPORTS for PATIENTS:
// GET /profile/patient/diagnosticReports - Read diagnostic reports of Patient
// GET /profile/patient/diagnosticReports/:id - Read diagnostic report of Patient by id
// POST /profile/patient/diagnosticReport - Create diagnostic report from Patient profile
// POST /profile/patient/qrcode/generate - QR code generate from Patient profile

app.get('/profile/patient/diagnosticReports', keycloak.protect('realm:patient'), async (req, res) => {
  try {
    const resp = await axios.get('/profile/patient/diagnosticReports', { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/patient/diagnosticReport/:id', keycloak.protect('realm:patient'), async (req, res) => {
  if (!validate(req, res)) return
  const { id } = req.params

  try {
    const response = await axios.get(`/profile/patient/diagnosticReport/${id}`, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.status(response.status).send(response.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.post('/profile/patient/diagnosticReport', keycloak.protect('realm:patient'), async (req, res) => {
  const payload = req.body
  const startDate = new Date(payload.effectiveDate)
  if (startDate > new Date()) return res.status(400).send({ message: "invalid effectiveDate" })
  try {
    const resp = await axios.post('/profile/patient/diagnosticReport', payload, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.post('/profile/patient/qrcode/generate', keycloak.protect('realm:patient'), async (req, res) => {
  try {
    const resp = await axios.post('/profile/patient/qrcode/generate', {}, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
});

// DIAGNOSTIC REPORTS for DEPENDENTS:
// GET /profile/caretaker/dependent/:id/diagnosticReports - Read diagnostic reports of Patient
// GET /profile/caretaker/dependent/:id/diagnosticReports/:id - Read diagnostic report of Patient by id
// POST /profile/caretaker/dependent/:id/diagnosticReport - Create diagnostic report from Patient profile
app.get('/profile/caretaker/dependent/:id/diagnosticReports', keycloak.protect('realm:patient'), async (req, res) => {
  if (!validate(req, res)) return
  const { id } = req.params

  try {
    const response = await axios.get(`/profile/caretaker/dependent/${id}/diagnosticReports`, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.status(response.status).send(response.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/caretaker/dependent/:idDependent/diagnosticReport/:id', keycloak.protect('realm:patient'), async (req, res) => {
  if (!validate(req, res)) return
  const { idDependent, id } = req.params

  try {
    const response = await axios.get(`/profile/caretaker/dependent/${idDependent}/diagnosticReport/${id}`, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.status(response.status).send(response.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.post('/profile/caretaker/dependent/:id/diagnosticReport', keycloak.protect('realm:patient'), async (req, res) => {
  const payload = req.body
  const { id } = req.params
  const startDate = new Date(payload.effectiveDate)
  if (startDate > new Date()) return res.status(400).send({ message: "invalid effectiveDate" })

  try {
    const resp = await axios.post(`/profile/caretaker/dependent/${id}/diagnosticReport`, payload, { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

//
// MANAGE organizations:
// Routes for managing organizations of Boldo Multi Organization (BMO)
// POST /profile/organization-manager/organization - creates a BMO organization
// GET /profile/organization-manager/organization - obtains a list of BMO organizations
// GET /organizations  - obtains a list of BMO organizations
// PUT /organization-manager/organization/:idOrganization - updates organization dto
// PUT /organization-manager/organization/:idOrganization/settings - updates organization settings
// GET /organization/patient/subscriptionRequests  - obtains a list of patients subscription requests
// PUT /organization/patient/subscriptionRequests  - accept/reject patients subscription requests 


app.post('/profile/organization-manager/organization', keycloak.protect('realm:organization_manager'), async (req, res) => {
  const payload = req.body
  try {
    const resp =  await axios.post('/profile/organization-manager/organization', payload, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/organization-manager/organization', keycloak.protect('realm:organization_manager'), async (req, res) => {
  try {
    const resp = await axios.get(`/profile/organization-manager/organization`,
      { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/organization-manager/organization/patient/subscriptionRequests', keycloak.protect('realm:organization_manager'), async (req, res) => {
  try {
    const resp = await axios.get(`/profile/organization-manager/organization/patient/subscriptionRequests`,
      { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.put('/profile/organization-manager/organization/patient/subscriptionRequests', keycloak.protect('realm:organization_manager'), async (req, res) => {
  const payload = req.body
  try {
    const resp =  await axios.put('/profile/organization-manager/organization/patient/subscriptionRequests', payload, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.put('/profile/organization-manager/organization/:idOrganization', keycloak.protect('realm:organization_manager'), async (req, res) => {
  const payload = req.body
  try {
    const resp =  await axios.put(`/profile/organization-manager/organization/${req.params.idOrganization}`, payload, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.put('/profile/organization-manager/organization/:idOrganization/settings', keycloak.protect('realm:organization_manager'), async (req, res) => {
  const payload = req.body
  try {
    const resp =  await axios.put(`/profile/organization-manager/organization/${req.params.idOrganization}/settings`, payload, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/organizations', async (req, res) => {
  const {  include } = req.query
  try {
    const resp = await axios.get(`/organizations${include ? `?include=${include}` : ''}`)
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})


//
// MANAGE PractitionerRole:
// Routes for managing relation among doctors and organizations
// POST /profile/organization-manager/doctorRole - create a relation among doctor and organization 
// GET /profile/organization-manager/doctorRole - list relation among doctor and organizations
//

app.post('/profile/organization-manager/doctorRole', keycloak.protect('realm:organization_manager'), async (req, res) => {
  const payload = req.body
  try {
    const resp =  await axios.post('/profile/organization-manager/doctorRole', payload, {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
  }
})

app.get('/profile/organization-manager/doctorRole', keycloak.protect('realm:organization_manager'), async (req, res) => {
  try {
    const resp = await axios.get(`/profile/organization-manager/doctorRole`,
      { headers: { Authorization: `Bearer ${getAccessToken(req)}` } })
    res.status(resp.status).send(resp.data)
  } catch (err) {
    handleError(req, res, err)
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
//ENDPOINTS FOR ADMIN
//POST /profile/admin/archiveAppointments - calls the archiveAppointments script.
app.post('/profile/admin/archiveAppointments', keycloak.protect('realm:admin'), async (req, res) => {
  try {
    const toReturn = await archiveAppointments()
    res.send('Script run successfully 🔥')
  } catch (err) {
    handleError(req, res, err)
  }
})

app.post('/profile/admin/farmanuario/synchronize', keycloak.protect('realm:admin'), async (req, res) => {
  try {
    const resp =  await axios.post('/farmanuario/synchronize', {},  {
      headers: { Authorization: `Bearer ${getAccessToken(req)}` },
    })
    res.send('Status: ' + resp.status + ' Data: ' + resp.data)
  } catch (err) {
    res.send(err)
    handleError(req, res, err)
  }
})

//
// REPORTS [open endpoint]
// GET /reports/:report_identifier_compound_code - Prescription verification URL
app.get('/reports/:id_compound_code',
  param('id_compound_code').isString(),
  async (req:express.Request, res:express.Response) => {
    if (!validate(req, res)){ return }
    const { id_compound_code: reportCompoundCode } = req.params
    try {
      const response = await axios.get(`/reports/${reportCompoundCode}`)
      res.set('Content-Type', 'text/html');
      res.end(response.data)
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
