import { SessionParameters } from "@matter/protocol";
import { StatusCode, ValidationMandatoryFieldMissingError } from "@matter/types/common";
import {
  TlvAttributeReport,
  TlvAttributeStatus,
  type DataReport,
  TlvDataReport,
  TlvEventReport,
  TlvInvokeResponse,
  TlvInvokeResponseData,
  TlvStatusResponse,
  TlvSubscribeResponse,
  TlvWriteResponse,
} from "@matter/types/protocol";
import { TlvArray, TlvBoolean, TlvEnum, TlvObject, TlvOptionalField, TlvUInt16, TlvUInt32, TlvUInt8 } from "@matter/types/tlv";
import type { Logging } from "homebridge";

const TLV_LENIENT_DATA_REPORT = TlvObject({
  subscriptionId: TlvOptionalField(0, TlvUInt32),
  attributeReports: TlvOptionalField(1, TlvArray(TlvAttributeReport)),
  eventReports: TlvOptionalField(2, TlvArray(TlvEventReport)),
  moreChunkedMessages: TlvOptionalField(3, TlvBoolean),
  suppressResponse: TlvOptionalField(4, TlvBoolean),
  interactionModelRevision: TlvOptionalField(0xff, TlvUInt8),
});
const TLV_LENIENT_STATUS_RESPONSE = TlvObject({
  status: TlvOptionalField(0, TlvEnum<StatusCode>()),
  interactionModelRevision: TlvOptionalField(0xff, TlvUInt8),
});
const TLV_LENIENT_INVOKE_RESPONSE = TlvObject({
  suppressResponse: TlvOptionalField(0, TlvBoolean),
  invokeResponses: TlvOptionalField(1, TlvArray(TlvInvokeResponseData)),
  moreChunkedMessages: TlvOptionalField(2, TlvBoolean),
  interactionModelRevision: TlvOptionalField(0xff, TlvUInt8),
});
const TLV_LENIENT_WRITE_RESPONSE = TlvObject({
  writeResponses: TlvOptionalField(0, TlvArray(TlvAttributeStatus)),
  interactionModelRevision: TlvOptionalField(0xff, TlvUInt8),
});
const TLV_LENIENT_SUBSCRIBE_RESPONSE = TlvObject({
  subscriptionId: TlvOptionalField(0, TlvUInt32),
  maxInterval: TlvOptionalField(2, TlvUInt16),
  interactionModelRevision: TlvOptionalField(0xff, TlvUInt8),
});

let matterCompatibilityPatchesInstalled = false;
let missingInteractionModelRevisionWarningLogged = false;

export function installMatterCompatibilityPatches(log?: Pick<Logging, "warn">): void {
  if (matterCompatibilityPatchesInstalled) {
    return;
  }

  patchInteractionSchema(TlvDataReport, TLV_LENIENT_DATA_REPORT, "ReportData", log);
  patchInteractionSchema(TlvStatusResponse, TLV_LENIENT_STATUS_RESPONSE, "StatusResponse", log);
  patchInteractionSchema(TlvInvokeResponse, TLV_LENIENT_INVOKE_RESPONSE, "InvokeResponse", log);
  patchInteractionSchema(TlvWriteResponse, TLV_LENIENT_WRITE_RESPONSE, "WriteResponse", log);
  patchInteractionSchema(TlvSubscribeResponse, TLV_LENIENT_SUBSCRIBE_RESPONSE, "SubscribeResponse", log);

  matterCompatibilityPatchesInstalled = true;
}

function patchInteractionSchema(
  schema: { decode: (payload: Uint8Array) => unknown },
  lenientSchema: { decode: (payload: Uint8Array) => { interactionModelRevision?: number } },
  label: string,
  log?: Pick<Logging, "warn">,
): void {
  const decodeStrict = schema.decode.bind(schema);

  schema.decode = (payload: Uint8Array) => {
    try {
      return decodeStrict(payload);
    } catch (error) {
      if (!isMissingInteractionModelRevisionError(error)) {
        throw error;
      }

      const decoded = lenientSchema.decode(payload);
      logMissingInteractionModelRevision(label, log);

      return {
        ...decoded,
        interactionModelRevision: decoded.interactionModelRevision ?? SessionParameters.defaults.interactionModelRevision,
      };
    }
  };
}

function logMissingInteractionModelRevision(label: string, log?: Pick<Logging, "warn">): void {
  if (missingInteractionModelRevisionWarningLogged) {
    return;
  }

  log?.warn(
    `Matter peer sent ${label} without interactionModelRevision; accepting it with a compatibility fallback.`,
  );
  missingInteractionModelRevisionWarningLogged = true;
}

function isMissingInteractionModelRevisionError(error: unknown): boolean {
  if (error instanceof ValidationMandatoryFieldMissingError) {
    return error.fieldName === "interactionModelRevision";
  }

  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Missing mandatory field interactionModelRevision");
}
