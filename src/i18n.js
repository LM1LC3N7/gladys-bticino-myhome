// -----------------------------------------------------------------------------
// The texts users read: the connection status, the command errors, the names
// of the devices and features. English and French. A text never carries the
// password nor a value the user typed (a wrong value is described, not shown).
// -----------------------------------------------------------------------------

/** entry ({ en, fr } of strings or functions) -> its text (or function) in a language. */
export const word = (entry, language) =>
  entry === undefined ? '' : typeof entry === 'string' ? entry : (entry[language] ?? entry.en);

/** An entry of functions, filled: { en, fr } of strings. */
export const fill = (entry, ...args) =>
  Object.fromEntries(
    ['en', 'fr'].map((lang) => {
      const value = word(entry, lang);
      return [lang, typeof value === 'function' ? value(...args) : value];
    }),
  );

export const T = {
  configUnread: {
    en: 'The configuration could not be read from Gladys: read again in 30 s.',
    fr: 'La configuration n’a pas pu être lue dans Gladys : nouvel essai dans 30 s.',
  },
  noHost: {
    en: 'Enter the address of the OpenWebNet gateway.',
    fr: 'Saisissez l’adresse de la passerelle OpenWebNet.',
  },
  badPassword: {
    en: 'The OPEN password holds characters a gateway never takes (spaces, accents): check it.',
    fr: 'Le mot de passe OPEN contient des caractères qu’aucune passerelle n’accepte (espaces, accents) : vérifiez-le.',
  },
  connecting: {
    en: 'Connecting to the gateway…',
    fr: 'Connexion à la passerelle…',
  },
  reading: {
    en: 'Connected, reading the installation…',
    fr: 'Connectée, lecture de l’installation…',
  },
  connected: {
    en: (lights, shutters, zones, extra) =>
      `Connected: ${lights} light point(s), ${shutters} shutter(s), ${zones} heating zone(s).${extra}`,
    fr: (lights, shutters, zones, extra) =>
      `Connectée : ${lights} point(s) lumineux, ${shutters} volet(s), ${zones} zone(s) de chauffage.${extra}`,
  },
  readFailed: {
    en: 'Connected to the event session, but the installation could not be read (no answer to the status requests).',
    fr: 'Connectée à la session d’événements, mais l’installation n’a pas pu être lue (pas de réponse aux demandes d’état).',
  },
  configErrors: {
    en: (n) =>
      ` ${n} entry(ies) of the dimmers, read only or zones fields not understood (ignored).`,
    fr: (n) =>
      ` ${n} entrée(s) des champs variateurs, lecture seule ou zones non comprise(s) (ignorée(s)).`,
  },
  offline: {
    en: (seconds) =>
      `The gateway does not answer${seconds ? `: next try in ${seconds} s` : ''}. Check its address and that it is on.`,
    fr: (seconds) =>
      `La passerelle ne répond pas${seconds ? ` : nouvel essai dans ${seconds} s` : ''}. Vérifiez son adresse et qu’elle est allumée.`,
  },
  busy: {
    en: 'The gateway refuses a new session (all its sessions in use?): next try later.',
    fr: 'La passerelle refuse une nouvelle session (toutes ses sessions occupées ?) : nouvel essai plus tard.',
  },
  refused: {
    en: 'The gateway refused the OPEN password: no new try until the password changes or "Test the connection" is clicked.',
    fr: 'La passerelle a refusé le mot de passe OPEN : plus d’essai tant que le mot de passe ne change pas ou que « Tester la connexion » n’est pas cliqué.',
  },
  passwordRequired: {
    en: 'The gateway asks for its OPEN password: enter it in the configuration.',
    fr: 'La passerelle demande son mot de passe OPEN : saisissez-le dans la configuration.',
  },
  passwordDigits: {
    en: 'This gateway only takes an OPEN password of digits (up to 10): check it.',
    fr: 'Cette passerelle n’accepte qu’un mot de passe OPEN numérique (10 caractères au plus) : vérifiez-le.',
  },
  identity: {
    en: 'The gateway did not prove it knows the OPEN password (another device at this address?): connection stopped until "Test the connection" is clicked.',
    fr: 'La passerelle n’a pas prouvé qu’elle connaît le mot de passe OPEN (un autre appareil à cette adresse ?) : connexion arrêtée jusqu’au clic sur « Tester la connexion ».',
  },
  otherGateway: {
    en: (seen, known) =>
      `Another gateway answers at this address (MAC ${seen}, known ${known}): commands stopped until "Test the connection" is clicked.`,
    fr: (seen, known) =>
      `Une autre passerelle répond à cette adresse (MAC ${seen}, connue ${known}) : commandes arrêtées jusqu’au clic sur « Tester la connexion ».`,
  },
  dataBroken: {
    en: ' /data cannot be read: read again every 10 s.',
    fr: ' /data illisible : relu toutes les 10 s.',
  },
  // Command errors (the text of a refused set_value).
  offlineCommand: {
    en: 'Not sent: the gateway does not answer.',
    fr: 'Non envoyée : la passerelle ne répond pas.',
  },
  tooLate: {
    en: 'Not sent: the gateway was busy for too long.',
    fr: 'Non envoyée : la passerelle est restée occupée trop longtemps.',
  },
  queueFull: {
    en: 'Not sent: too many commands are waiting.',
    fr: 'Non envoyée : trop de commandes en attente.',
  },
  replaced: {
    en: 'Not sent: a stop or an off of the same device came after it.',
    fr: 'Non envoyée : un arrêt ou une extinction du même appareil est arrivé après elle.',
  },
  gatewayRefused: {
    en: 'The gateway refused the command (NACK): nothing done.',
    fr: 'La passerelle a refusé la commande (NACK) : rien n’a été fait.',
  },
  unconfirmed: {
    en: (what) => `${what}: sent, without confirmation yet (read again in 5 s and 20 s).`,
    fr: (what) => `${what} : envoyée, sans confirmation pour l’instant (relue dans 5 s et 20 s).`,
  },
  keptForLater: {
    en: (what) =>
      `${what}: not sent, the gateway does not answer. It is kept and sent before anything else as soon as the gateway answers.`,
    fr: (what) =>
      `${what} : non envoyée, la passerelle ne répond pas. Elle est gardée et envoyée avant tout le reste dès que la passerelle répond.`,
  },
  keptBusy: {
    en: (what) =>
      `${what}: not sent yet, the gateway is busy (a request in progress, or no free session). It is kept and sent before anything else as soon as it can be.`,
    fr: (what) =>
      `${what} : pas encore envoyée, la passerelle est occupée (requête en cours, ou plus de session libre). Elle est gardée et envoyée avant tout le reste dès que possible.`,
  },
  keptStopped: {
    en: (what) =>
      `${what}: not sent, the connection is stopped (see the status). It is kept and sent before anything else once the password is fixed or "Test the connection" succeeds.`,
    fr: (what) =>
      `${what} : non envoyée, la connexion est arrêtée (voir l’état). Elle est gardée et envoyée avant tout le reste dès que le mot de passe est corrigé ou que « Tester la connexion » réussit.`,
  },
  gatewayRefusedKept: {
    en: 'The gateway refused it (NACK): nothing done for now. It is kept and sent again after 10 s, 30 s, 1 min, 2 min, then every 5 min until it is applied.',
    fr: 'La passerelle l’a refusée (NACK) : rien n’est fait pour l’instant. Elle est gardée et renvoyée après 10 s, 30 s, 1 min, 2 min puis toutes les 5 min jusqu’à ce qu’elle soit appliquée.',
  },
  readOnly: {
    en: 'This point is read only in the configuration: nothing sent.',
    fr: 'Ce point est en lecture seule dans la configuration : rien n’est envoyé.',
  },
  badValue: {
    en: 'This value is not accepted: nothing sent.',
    fr: 'Cette valeur n’est pas acceptée : rien n’est envoyé.',
  },
  unknownTarget: {
    en: 'This device is not in the configuration any more: nothing sent.',
    fr: 'Cet appareil n’est plus dans la configuration : rien n’est envoyé.',
  },
  notConfigured: {
    en: 'The integration is not configured yet: nothing sent.',
    fr: 'L’intégration n’est pas encore configurée : rien n’est envoyé.',
  },
  stopped: {
    en: 'The connection is stopped (see the status of the integration): nothing sent.',
    fr: 'La connexion est arrêtée (voir l’état de l’intégration) : rien n’est envoyé.',
  },
  identityUnknown: {
    en: 'Not sent: the gateway could not be identified yet.',
    fr: 'Non envoyée : la passerelle n’a pas encore pu être identifiée.',
  },
  thermostatDisabled: {
    en: 'Changing the thermostats from Gladys is disabled in the configuration: nothing sent.',
    fr: 'Le réglage des thermostats depuis Gladys est désactivé dans la configuration : rien n’est envoyé.',
  },
  setpointRange: {
    en: (min, max) => `The set point must be between ${min} and ${max} °C: nothing sent.`,
    fr: (min, max) =>
      `La consigne doit être comprise entre ${min} et ${max} °C : rien n’est envoyé.`,
  },
  zoneUnknown: {
    en: 'Not sent: the zone could not be read just before (its set point or mode is unknown).',
    fr: 'Non envoyée : la zone n’a pas pu être relue juste avant (consigne ou mode inconnu).',
  },
  zoneStopping: {
    en: 'Not sent: the heating of this zone is being switched off.',
    fr: 'Non envoyée : le chauffage de cette zone est en cours d’extinction.',
  },
  modeUnsupported: {
    en: 'Only "Off" and "Automatic (program)" can be chosen here: to heat, set a set point.',
    fr: 'Seuls « Arrêt » et « Automatique (programme) » se choisissent ici : pour chauffer, réglez une consigne.',
  },
  autoStandalone: {
    en: 'A stand-alone thermostat has no program of a central unit: "Automatic" is not sent.',
    fr: 'Un thermostat autonome n’a pas de programme de centrale : « Automatique » n’est pas envoyé.',
  },
};

export const COMMAND_NAMES = {
  lightOn: { en: (id) => `Light ${id} on`, fr: (id) => `Allumage de ${id}` },
  lightOff: { en: (id) => `Light ${id} off`, fr: (id) => `Extinction de ${id}` },
  dimmer: {
    en: (id, level) => `Light ${id} at ${level} %`,
    fr: (id, level) => `Lumière ${id} à ${level} %`,
  },
  shutterUp: { en: (id) => `Shutter ${id} up`, fr: (id) => `Ouverture du volet ${id}` },
  shutterDown: { en: (id) => `Shutter ${id} down`, fr: (id) => `Fermeture du volet ${id}` },
  shutterStop: { en: (id) => `Shutter ${id} stop`, fr: (id) => `Arrêt du volet ${id}` },
  shutterPosition: {
    en: (id, p) => `Shutter ${id} to ${p} %`,
    fr: (id, p) => `Volet ${id} à ${p} %`,
  },
  zoneOff: { en: (z) => `Heating zone ${z} off`, fr: (z) => `Arrêt du chauffage zone ${z}` },
  zoneAuto: {
    en: (z) => `Heating zone ${z} automatic`,
    fr: (z) => `Chauffage zone ${z} en automatique`,
  },
  setpoint: {
    en: (z, t) => `Zone ${z} set point ${t} °C`,
    fr: (z, t) => `Consigne zone ${z} à ${t} °C`,
  },
};

export const DEVICE_NAMES = {
  light: { en: (p) => `MyHOME light ${p}`, fr: (p) => `Lumière MyHOME ${p}` },
  dimmer: { en: (p) => `MyHOME dimmer ${p}`, fr: (p) => `Variateur MyHOME ${p}` },
  shutter: { en: (p) => `MyHOME shutter ${p}`, fr: (p) => `Volet MyHOME ${p}` },
  zone: { en: (z) => `MyHOME heating zone ${z}`, fr: (z) => `Zone de chauffage MyHOME ${z}` },
};

export const FEATURE_NAMES = {
  binary: { en: 'On / off', fr: 'Allumée / éteinte' },
  brightness: { en: 'Brightness', fr: 'Luminosité' },
  readonly: { en: 'State (read only)', fr: 'État (lecture seule)' },
  state: { en: 'Open / close / stop', fr: 'Ouvrir / fermer / arrêter' },
  position: { en: 'Position', fr: 'Position' },
  temperature: { en: 'Temperature', fr: 'Température' },
  target: { en: 'Set point', fr: 'Consigne' },
  mode: { en: 'Mode', fr: 'Mode' },
};

export const MODE_LABELS = {
  off: { en: 'Off', fr: 'Arrêt' },
  heating: { en: 'Heating (manual)', fr: 'Chauffage (manuel)' },
  cooling: { en: 'Cooling (manual)', fr: 'Climatisation (manuel)' },
  auto: { en: 'Automatic (program)', fr: 'Automatique (programme)' },
};
