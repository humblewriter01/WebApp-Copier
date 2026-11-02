import React from 'react';

export const BROKER_ACCESS_REASSURANCE = 'Broker access is trade-only. We can place and close trades, but we can never withdraw funds. Disconnect anytime.';

export default function BrokerAccessNote({ className = '' }) {
  return <p className={`broker-access-note ${className}`.trim()}>
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M10 1.8 16.2 4v4.7c0 4.2-2.6 7.3-6.2 9.5-3.6-2.2-6.2-5.3-6.2-9.5V4L10 1.8Z" />
      <rect x="7.1" y="8.3" width="5.8" height="4.8" rx=".8" />
      <path d="M8.5 8.2V6.9a1.5 1.5 0 0 1 3 0v1.3" />
    </svg>
    <span>{BROKER_ACCESS_REASSURANCE}</span>
  </p>;
}
