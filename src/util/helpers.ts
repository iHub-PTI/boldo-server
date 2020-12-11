import axios from 'axios'
import { addDays, differenceInDays } from 'date-fns'
import express, { response } from 'express'
import { validationResult } from 'express-validator'
import jwt from 'jsonwebtoken'

import { createLoginUrl } from './kc-helpers'
import calculateOpenIntervals from '../worker/getOpenIntervals'
import Appointment from '../models/Appointment'
import Doctor, { IDoctor } from '../models/Doctor'
import { ICoreAppointment } from '../models/CoreAppointment'

type Interval = [number, number]

export const APPOINTMENT_LENGTH = 30 /**minutes in milliseconds*/ * 1000 * 60

export const calculateAvailability = async (doctorId: string, start: Date, end: Date) => {
  try {
    // Get the doctor._id and opening hours
    const doctor = await Doctor.findOne({ id: doctorId })
    if (!doctor) return []

    // Get all the FHIR appointments

    // FIXME: There is an issue with FHIR not returning events that start before the startDate but end after the start date.
    // Therefore use 1h before appointment.
    const startFHIR = new Date(start)
    startFHIR.setHours(startFHIR.getHours() - 1)
    const resp = await axios.get<iHub.Appointment[]>(
      `/appointments?doctors=${doctorId}&start=${startFHIR.toISOString()}&end=${end.toISOString()}`
    )

    // Get the doctors other appointments
    const appointments = await Appointment.find({ doctorId: doctor._id, end: { $gt: start }, start: { $lt: end } })

    // Transforming the data
    const iHubAppointments = resp.data.map(appointment => [Date.parse(appointment.start), Date.parse(appointment.end)])
    const boldoAppointments = appointments.map(appointment => [appointment.start.getTime(), appointment.end.getTime()])
    const blockedIntervals = [...boldoAppointments, ...iHubAppointments] as Interval[]

    // Expand openingHours to intervals
    const openHourDates = calculateOpenHours(doctor.openHours, start, end) as Interval[]

    // Calcualte availability intervals
    const openIntervals = await calculateOpenIntervals({ base: openHourDates, substract: blockedIntervals })

    // Slize availabilities into junks of appointment lengths
    const availabilities = openIntervals
      .flatMap(interval => {
        const intervals = [] as number[]
        let [start, end] = interval

        while (end - start >= APPOINTMENT_LENGTH) {
          intervals.push(start)
          start = start + APPOINTMENT_LENGTH
        }
        return intervals
      })
      .sort((a, b) => a - b)
      .map(date => new Date(date))
      .filter(date => date >= start && date <= end)
      .map(date => date.toISOString())

    return availabilities
  } catch (err) {
    throw err
  }
}

const calculateOpenHours = (openHours: IDoctor['openHours'], start: Date, end: Date) => {
  // Create list of days
  const days = differenceInDays(end, start)
  const daysList = [...Array(days + 1).keys()].map(i => addDays(start, i))
  return daysList.flatMap(day => {
    const dayOfTheWeek = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][day.getDay()] as keyof IDoctor['openHours']
    const openHoursOfDay = openHours[dayOfTheWeek]

    return openHoursOfDay.map(openHour => {
      let localDateString = new Date(day).toLocaleString('en-US', { timeZone: 'America/Asuncion' })

      let localStartDate = new Date(localDateString)
      localStartDate.setHours(0, openHour.start, 0)

      let localEndDate = new Date(localDateString)
      localEndDate.setHours(0, openHour.end, 0)

      return [localStartDate.getTime(), localEndDate.getTime()]
    })
  })
}

export const calculateNextAvailability = async (doctorId: string) => {
  const startDate = new Date()
  startDate.setMilliseconds(startDate.getMilliseconds() + APPOINTMENT_LENGTH)
  const endDate = new Date(startDate)
  endDate.setDate(endDate.getDate() + 7)
  const availabilitiesWeek = await calculateAvailability(doctorId, startDate, endDate)
  if (availabilitiesWeek.length > 0) return availabilitiesWeek[0]

  startDate.setDate(startDate.getDate() + 7)
  endDate.setDate(endDate.getDate() + 24)
  const availabilitiesMonth = await calculateAvailability(doctorId, startDate, endDate)

  if (availabilitiesMonth.length > 0) return availabilitiesMonth[0]
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
