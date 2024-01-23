import axios from 'axios'
import { addDays, differenceInDays } from 'date-fns'
import express, { response } from 'express'
import { validationResult } from 'express-validator'
import jwt from 'jsonwebtoken'

import { createLoginUrl } from './kc-helpers'
import calculateOpenIntervals from '../worker/getOpenIntervals'
import Appointment from '../models/Appointment'
import Doctor, { IDoctor, OpenHour } from '../models/Doctor'
import { ICoreAppointment } from '../models/CoreAppointment'

export type Interval = [number, number]

export const APPOINTMENT_LENGTH = Number(process.env.APPOINTMENT_LENGTH) /**minutes in milliseconds*/ * 1000 * 60
export const APPOINTMENT_WAIT_RESERVATION_LENGTH = Number(process.env.APPOINTMENT_WAIT_RESERVATION_LENGTH) /**minutes in milliseconds*/ * 1000 * 60


export const calculateAvailability = async (doctorId: string, idOrganization: string, start: Date, end: Date, accessToken: string, patientType: string, dependentId: any) => {

  //we must check all the blocked intervals from the start and end day during the appointments queries
  let newStart = new Date(start);
  //we use the start hour of the start day
  newStart.setHours(0);
  let newEnd = new Date(end); 
  //we use the end hour of the end day
  newEnd.setHours(24);

  try {
    // Get the doctor._id and opening hours
    const doctor = await Doctor.findOne(
      { id: doctorId, "blocks.idOrganization": idOrganization }
    )
    if (!doctor) return []

    const config = doctor.blocks.find(b => b.idOrganization == idOrganization);
    if (!config) return [];

    console.log(newStart.toISOString());
    console.log(newEnd.toISOString());
    // Get all the FHIR appointments

    // (Deprecated) FIXME: There is an issue with FHIR not returning events that start before the startDate but end after the start date.
    // (Deprecated) Therefore use 1h before appointment.
    // FIX MAY NOT BE REQUIRED ANYMORE, SINCE NOW ALL APPOINTMENTS STARTING FROM 00:00 HS ARE CONSIDERED
    // MOREOVER THERE ARE NOT APPOINTMENTS THAT START IN ONE DAY AND END IN THE NEXT ONE
    let path = `/profile/patient/appointments?calculateAvailability=true&doctors=${doctorId}&organizations=${idOrganization}&start=${newStart.toISOString()}&end=${newEnd.toISOString()}&status=Booked`;
    if (patientType == 'dependent') {
      path = `/profile/caretaker/dependent/${dependentId}/appointments?calculateAvailability=true&doctors=${doctorId}&organizations=${idOrganization}&start=${newStart.toISOString()}&end=${newEnd.toISOString()}&status=Booked`;
    } 
    const resp = await axios.get<iHub.Appointment[]>(
      path,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    )

    // Get the doctors other appointments
    const appointments = await Appointment.find({ doctorId: doctor._id, end: { $gt: newStart }, start: { $lt: newEnd }, idOrganization: idOrganization })

    // Transforming the data
    const iHubAppointments = resp.data.map(appointment => [Date.parse(appointment.start), Date.parse(appointment.end)])
    const boldoAppointments = appointments.map(appointment => [appointment.start.getTime(), appointment.end.getTime()])
    const blockedIntervals = [...boldoAppointments, ...iHubAppointments] as Interval[]

    // Expand openingHours to intervals
    const openHourDates = calculateOpenHours(config.openHours, start, end) as unknown as [number,number,string][]
    
    // Calcualte availability intervals
    const openIntervals = await calculateOpenIntervals({base:openHourDates, substract:blockedIntervals}) as [number,number,string][]

    // Slize availabilities into junks of appointment lengths
    const availabilities = openIntervals
      .flatMap(interval => {
        const i = interval as unknown as [number,number,string]
        const intervals = [] as [number,string][]
        let start = i[0]
        let end = i[1]
        let appType = i[2]

        // let [start, end] = interval[0]
        // let appType = interval[1]
        while (end - start >= APPOINTMENT_LENGTH) {
          intervals.push([start,appType])
          start = start + APPOINTMENT_LENGTH
        }
        return intervals
      })
      .sort((a, b) => a[0] - b[0])
      .map(date => [new Date(date[0]),date[1]] as [Date, string])
      .filter(date => date[0] >= start && date[0] <= end) 
      .map(date => [(date[0] as Date).toISOString(),date[1]] as unknown as [string, string])

    return availabilities.map(av => ({"availability":av[0],"appointmentType":av[1]}))
  } catch (err) {
    console.log('ERR HERE1')
    throw err
  }
}

const calculateOpenHours = (openHours: OpenHour, start: Date, end: Date) => {
  // Create list of days
  const days = differenceInDays(end, start)
  const daysList = [...Array(days + 1).keys()].map(i => addDays(start, i))
  return daysList.flatMap(day => {
    const dayOfTheWeek = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][day.getDay()] as keyof OpenHour
    const openHoursOfDay = openHours[dayOfTheWeek]

    return openHoursOfDay.map(openHour => {
      let localDateString = new Date(day).toLocaleString('en-US', { timeZone: 'America/Asuncion' })

      let localStartDate = new Date(localDateString)
      localStartDate.setHours(0, openHour.start, 0)

      let localEndDate = new Date(localDateString)
      localEndDate.setHours(0, openHour.end, 0)

      return [localStartDate.getTime(), localEndDate.getTime(), openHour.appointmentType]
    })
  })
}

export const calculateNextAvailability = async (doctorId: string, idOrganization: string, accessToken: string, typeOfAvailabilityParam: String, patientType: string, dependentId: any) => {
  const startDate = new Date()
  startDate.setMilliseconds(startDate.getMilliseconds() + APPOINTMENT_WAIT_RESERVATION_LENGTH)
  const endDate = new Date(startDate)
  endDate.setDate(endDate.getDate() + 7)
  let availabilitiesWeek = await calculateAvailability(doctorId, idOrganization, startDate, endDate, accessToken, patientType, dependentId)
  if (availabilitiesWeek.length > 0) {
    if (typeOfAvailabilityParam != "") {
      availabilitiesWeek = availabilitiesWeek.filter((w: any) => w.appointmentType == typeOfAvailabilityParam)
    } 
    if (availabilitiesWeek.length > 0) {
      return availabilitiesWeek[0];
    } 
  }
  startDate.setDate(startDate.getDate() + 7)
  endDate.setDate(endDate.getDate() + 24)
  let availabilitiesMonth = await calculateAvailability(doctorId, idOrganization, startDate, endDate, accessToken, patientType, dependentId)
  if (availabilitiesMonth.length > 0) {
    if (typeOfAvailabilityParam != "") {
      availabilitiesMonth = availabilitiesMonth.filter((w: any) => w.appointmentType == typeOfAvailabilityParam)
    } 
    if (availabilitiesMonth.length > 0) {
      return availabilitiesMonth[0];
    } 
  }
  return null
}

export const handleError = (req: express.Request, res: express.Response, err: any) => {
  if (err.status) {
    console.log(`${err.message} ${err.name ? err.name : ''}`)
    return res.status(err.status).send({ message: err.message })
  } else if (err.isAxiosError) {
    console.log('axios:', err.response?.data || err.message)
    if (err.response?.status === 401) return res.status(401).send({ message: createLoginUrl(req, '/login') })
    if (err.response) return res.status(err.response.status).send(err.response.data)
    return res.sendStatus(500)
  } else {
    console.log(err)
    return res.sendStatus(500)
  }
}

// FIXME random Express Error when using req: express.Request, res: express.Response
export function validate(req: any, res: any) {
  const errorFormatter = ({ msg, param }: { msg: string; param: string }) => {
    return `${param}: ${msg}`
  }
  const errors = validationResult(req).formatWith(errorFormatter)
  if (!errors.isEmpty()) {
    console.log(errors)
    res.status(400).send({ message: `Validation failed! ${errors.array().join(', ')}.` })
    return false
  }
  return true
}

export const createToken = (ids: string[], subject: 'patient' | 'doctor') => {
  try {
    const token = jwt.sign({ ids }, process.env.PRIVATE_KEY!, {
      expiresIn: '1d',
      algorithm: 'RS256',
      issuer: 'boldo-server',
      audience: 'boldo-sockets',
      subject,
    })
    return token
  } catch (err) {
    throw err
  }
}

export async function filterByAppointmentAvailability(doctors: iHub.Doctor[], typeOfAvailabilityParam: String){
  if (!doctors){
    return doctors;
  }

  let ids = doctors.map(doctor => doctor.id);
  //the filtering is done in the MongoDB
  let doctorsIHub = await Doctor.find(
    {'id': { $in:ids },
    $or:[ 
      {'blocks.openHours.mon': { $elemMatch: { appointmentType: {$regex: '.*' + typeOfAvailabilityParam + '.*' }}}},
      {'blocks.openHours.tue': { $elemMatch: { appointmentType: {$regex: '.*' + typeOfAvailabilityParam + '.*' }}}},
      {'blocks.openHours.wed': { $elemMatch: { appointmentType: {$regex: '.*' + typeOfAvailabilityParam + '.*' }}}},
      {'blocks.openHours.thu': { $elemMatch: { appointmentType: {$regex: '.*' + typeOfAvailabilityParam + '.*' }}}},
      {'blocks.openHours.fri': { $elemMatch: { appointmentType: {$regex: '.*' + typeOfAvailabilityParam + '.*' }}}},
      {'blocks.openHours.sat': { $elemMatch: { appointmentType: {$regex: '.*' + typeOfAvailabilityParam + '.*' }}}},
      {'blocks.openHours.sun': { $elemMatch: { appointmentType: {$regex: '.*' + typeOfAvailabilityParam + '.*' }}}}]}
    );

  var hashDociHubs = new Map(doctorsIHub.map(item => [item.id, item]));
  //return only the doctos that were obtained from MongoDB
  let doctorsToReturn = doctors.filter(doctor => hashDociHubs.get(doctor.id))
  return doctorsToReturn
}

export async function doctorAvailability(req: express.Request, res: express.Response, patientType: any, accessToken: string) {
  if (!validate(req, res)) return

  const { start, end, organizationIdList, appointmentType } = req.query
  const { idDoctor: doctorId, idDependet: dependentId } = req.params

  try {
    let startDate = new Date(start as string)
    let endDate = new Date(end as string)
    let typeOfAvailabilityParam = "";
    if (appointmentType) {
      typeOfAvailabilityParam = appointmentType as string;
    }

    const now = new Date()
    now.setMilliseconds(now.getMilliseconds() + APPOINTMENT_WAIT_RESERVATION_LENGTH)

    if (startDate < now) startDate = now
    if (endDate < startDate)
      return res.status(400).send({ message: 'End Date has to be larger than start and in the future' })

    if (differenceInDays(endDate, startDate) > 30) {
      endDate = new Date(startDate)
      endDate.setDate(endDate.getDate() + 31)
    }

    let availabilitiesBlocks: any[] = [];
    let organizationsId: any[] = [];
    let path = `/profile/patient/doctors/${doctorId}/common-organizations`;
    if (patientType == 'dependent') {
      path = `/profile/caretaker/dependent/${dependentId}/doctors/${doctorId}/common-organizations`;
    } 
    const commonOrganizations = await axios.get<iHub.Organization[]>(path, { headers: { Authorization: `Bearer ${accessToken}` } })
    console.log(commonOrganizations.data);

    if (organizationIdList) {
      const organizations = (organizationIdList as string).split(",");
      console.log(organizations)
  
      for (const idOrganization of organizations) {
        if (commonOrganizations.data.map(org => org.id).includes(idOrganization)) {
          organizationsId.push(idOrganization);
        }
      }
    } else {
      organizationsId = commonOrganizations.data.map(org => org.id);
    }
    console.log(organizationsId)
    
    try {
      for (const idOrganization of organizationsId) {
        let availabilities = await calculateAvailability(doctorId, idOrganization, startDate, endDate, accessToken, patientType, dependentId);
        if (typeOfAvailabilityParam != "") {
          availabilities = availabilities.filter((w: any) => w.appointmentType.includes(typeOfAvailabilityParam));
        }
        const nextAvailability = await calculateNextAvailability(doctorId, idOrganization, accessToken, typeOfAvailabilityParam, patientType, dependentId);          
        availabilitiesBlocks.push({ idOrganization: idOrganization, nameOrganization: commonOrganizations.data.find(org => org.id == idOrganization)?.name, availabilities, nextAvailability });  
      }
    } catch (err) {
      console.log(err)
    }

    // FIXME: nextAvailability is runing the whole loop again.
    // Could be done in one loop in the case that start = now
    // Also starts two workers. Could start one
    console.log("final results availability: ", availabilitiesBlocks);
    res.send(availabilitiesBlocks)
  } catch (err) {
    handleError(req, res, err)
  }
}

export async function getDoctorsWithAvailability(req: express.Request, res: express.Response, endpoint: string, queryString: string, accessToken: string) {
  try {
    const resp = await axios.get<{ items: iHub.Doctor[]; total: number }>(
      endpoint, 
      {
        headers: { Authorization: `Bearer ${accessToken}` }
      }
    )
    if(resp.data.items==null) {
      res.send({ items: [], total: 0 });
    } else {
      res.send({ items: resp.data.items, total: resp.data.total });
    }
    /*else {
      let doctorsIHub = resp.data.items;
      let typeOfAvailabilityParam = "";
      if (queryString) {
        //creates a map from queryString
        const qMap = queryString.split('&').reduce((mapAccumulator, obj) => {
          let queryK = obj.split('=')[0]
          let queryV = obj.split('=')[1]
          mapAccumulator.set(queryK, queryV);
          return mapAccumulator;
        }, new Map());
        if (qMap.has('appointmentType') && qMap.get('appointmentType')){
          typeOfAvailabilityParam = qMap.get('appointmentType');
          //filter doctors by checking if they dispose with a schedule with the type of Appointment specified 
          doctorsIHub = await filterByAppointmentAvailability(resp.data.items, qMap.get('appointmentType'))
        }
      }
    // FIXME: this currently creates one worker per doctor with huge overhead.
    // Probably best to move this into a own worker.
      const doctorsWithNextAvailability = await Promise.all(
        doctorsIHub.map(async doctor => {
          for (const o of doctor.organizations) {
            o.nextAvailability = await calculateNextAvailability(doctor.id, o.id, accessToken, typeOfAvailabilityParam, 'main', null)
          }
          return doctor
        })
      )
      res.send({ items: doctorsWithNextAvailability, total: resp.data.total })
    }*/
  } catch (err) {
    handleError(req, res, err)
  }
}
