// Type definitions for iHub
// Project: https://ihub.com.py/
// Definitions by: Björn Schmidtke <https://github.com/pa1nd>
// TypeScript Version: 3.9

export as namespace iHub

export interface Doctor {
  id: string
  photoUrl?: string
  givenName: string
  familyName: string
  languages: string[]
  biography?: string
  birthDate: string
  gender: string
  email: string
  phone?: string
  street?: string
  city?: string
  neighborhood?: string
  addressDescription?: string
  specializations: string[]
  license?: string // not writable
  organizations: Organization[]
}

export interface Patient {
  id: string
  photoUrl: string
  givenName: string
  familyName: string
  birthDate: string
  occupation: string
  gender: string
  email: string
  phone: string
  street: string
  city: string
  neighborhood: string
  reference: string
}

export interface Specialization {
  id: string
  description: string
}

export interface Appointment {
  id: string
  start: string
  end: string
  appointmentType: "A"|"V"
  patientId: Patient['id']
  doctorId: Doctor['id']
  description: string
  organizationId: string
}

export interface Organization {
  id: string
  active: boolean
  name: string
  type: string
  nextAvailability: any
}