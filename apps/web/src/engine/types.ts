import type { Object3D } from 'three';
import type { FitResponse, Landmarks } from '../api';
export type { GarmentSpec, GarmentFitResponse as FitResult } from '../api';
export type { components } from '@satisfy/api-types';

export interface BodyModel {
  mesh: Object3D;
  landmarks: Landmarks;
  measurements: FitResponse['measurements'];
}
