import type {
  CapabilityValue,
  DeviceCommand,
  DeviceDefinition,
  DeviceKind,
} from "../domain/device.js";

export type HcuFeature = { type: string } & Record<string, unknown>;

export interface HcuDevice {
  deviceId: string;
  deviceType: string;
  friendlyName: string;
  modelType: string;
  features: HcuFeature[];
}

interface FieldBinding {
  field: string;
  capabilityId: string;
  toHcu?: (value: CapabilityValue) => unknown;
  fromHcu?: (value: unknown) => CapabilityValue;
}

interface FeatureSpec {
  type: string;
  fields: readonly FieldBinding[];
}

const percentToFraction = (value: CapabilityValue) =>
  typeof value === "number" ? value / 100 : value;

/** Standard HomeFlow capability IDs and the Connect API feature fields they correspond to. */
const FEATURES: readonly FeatureSpec[] = [
  {
    type: "batteryState",
    fields: [
      { field: "batteryLevel", capabilityId: "battery_level", toHcu: percentToFraction },
      { field: "batteryCapacity", capabilityId: "battery_capacity_wh" },
    ],
  },
  { type: "currentPower", fields: [{ field: "currentPower", capabilityId: "power_w" }] },
  {
    type: "energyCounter",
    fields: [
      { field: "in", capabilityId: "energy_in_kwh" },
      { field: "out", capabilityId: "energy_out_kwh" },
    ],
  },
  {
    type: "setPointTemperature",
    fields: [{ field: "setPointTemperature", capabilityId: "target_temperature_c" }],
  },
  {
    type: "climateOperationMode",
    fields: [
      {
        field: "climateOperationMode",
        capabilityId: "operation_mode",
        toHcu: (value) => String(value).toUpperCase(),
        fromHcu: (value) => String(value).toLowerCase(),
      },
    ],
  },
  { type: "switchState", fields: [{ field: "on", capabilityId: "on" }] },
];

const ARCHETYPES: Record<DeviceKind, { deviceType: string; required: string }> = {
  battery: { deviceType: "BATTERY", required: "batteryState" },
  inverter: { deviceType: "INVERTER", required: "currentPower" },
  "energy-meter": { deviceType: "ENERGY_METER", required: "currentPower" },
  "grid-connection-point": { deviceType: "GRID_CONNECTION_POINT", required: "currentPower" },
  "heat-pump": { deviceType: "HEAT_PUMP", required: "climateOperationMode" },
  thermostat: { deviceType: "THERMOSTAT", required: "setPointTemperature" },
  switch: { deviceType: "SWITCH", required: "switchState" },
};

export type MappingResult =
  | { ok: true; device: HcuDevice }
  | { ok: false; reason: string };

export class ControlMappingError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ControlMappingError";
  }
}

function buildFeature(
  spec: FeatureSpec,
  device: DeviceDefinition,
  values: ReadonlyMap<string, CapabilityValue>,
): HcuFeature | undefined {
  const defined = spec.fields.filter((binding) =>
    device.capabilities.some((capability) => capability.id === binding.capabilityId),
  );
  if (defined.length === 0) {
    return undefined;
  }

  const feature: HcuFeature = { type: spec.type };
  for (const binding of defined) {
    const value = values.get(binding.capabilityId);
    if (value !== undefined) {
      feature[binding.field] = binding.toHcu ? binding.toHcu(value) : value;
    }
  }
  return feature;
}

export function buildFeatures(
  device: DeviceDefinition,
  values: ReadonlyMap<string, CapabilityValue>,
  available: boolean,
): HcuFeature[] {
  const features = FEATURES.flatMap((spec) => buildFeature(spec, device, values) ?? []);
  features.push({ type: "maintenance", unreach: !available });
  return features;
}

export function buildFeatureOf(
  featureType: string,
  device: DeviceDefinition,
  values: ReadonlyMap<string, CapabilityValue>,
): HcuFeature | undefined {
  const spec = FEATURES.find((candidate) => candidate.type === featureType);
  return spec ? buildFeature(spec, device, values) : undefined;
}

export function featureTypeOf(capabilityId: string): string | undefined {
  return FEATURES.find((spec) =>
    spec.fields.some((binding) => binding.capabilityId === capabilityId),
  )?.type;
}

export function toHcuDevice(
  device: DeviceDefinition,
  values: ReadonlyMap<string, CapabilityValue>,
  available: boolean,
): MappingResult {
  if (!device.kind) {
    return { ok: false, reason: "device has no kind" };
  }
  const archetype = ARCHETYPES[device.kind];
  const features = buildFeatures(device, values, available);
  if (!features.some((feature) => feature.type === archetype.required)) {
    return {
      ok: false,
      reason: `${archetype.deviceType} requires the ${archetype.required} feature, which this device does not provide`,
    };
  }

  return {
    ok: true,
    device: {
      deviceId: device.id,
      deviceType: archetype.deviceType,
      friendlyName: device.name,
      modelType: device.model,
      features,
    },
  };
}

/** Translates requested target values into HomeFlow commands; any unsupported part rejects the whole request. */
export function toCommands(
  device: DeviceDefinition,
  features: readonly HcuFeature[],
): DeviceCommand[] {
  const commands: DeviceCommand[] = [];
  for (const requested of features) {
    const spec = FEATURES.find((candidate) => candidate.type === requested.type);
    if (!spec) {
      throw new ControlMappingError(`Feature "${requested.type}" cannot be controlled`);
    }

    const fields = Object.keys(requested).filter((key) => key !== "type");
    if (fields.length === 0) {
      throw new ControlMappingError(`Feature "${requested.type}" contains no target values`);
    }
    for (const field of fields) {
      const binding = spec.fields.find((candidate) => candidate.field === field);
      const defined =
        binding &&
        device.capabilities.some((capability) => capability.id === binding.capabilityId);
      if (!binding || !defined) {
        throw new ControlMappingError(`Field "${requested.type}.${field}" is not supported`);
      }
      const raw = requested[field];
      commands.push({
        deviceId: device.id,
        capabilityId: binding.capabilityId,
        value: binding.fromHcu ? binding.fromHcu(raw) : (raw as CapabilityValue),
      });
    }
  }
  return commands;
}
