# BTicino / Legrand MyHOME

Cette intégration relie Gladys à une installation **BTicino / Legrand MyHOME** (bus SCS) par une passerelle
IP **OpenWebNet** (MyHOMEServer1, F454, F455, MH201, MH202…), sur le réseau local : points lumineux, variateurs,
volets roulants et zones de chauffage.

> **Non officielle**, sans lien avec BTicino ni Legrand. Elle n’a **jamais été testée avec une vraie
> installation** : elle a été écrite d’après la spécification OpenWebNet publiée par BTicino et la bibliothèque
> OWNd, puis testée contre une passerelle simulée. Vos retours sont les bienvenus.

## Ce qu’il faut

- Une passerelle OpenWebNet joignable depuis Gladys (port TCP 20000 par défaut) ; donnez-lui une adresse fixe.
- Son **mot de passe OPEN** si elle en demande un (souvent `12345` d’usine ; il se change dans MyHOME_Suite).
  Les passerelles anciennes n’acceptent qu’un mot de passe numérique ; les récentes acceptent aussi des
  lettres (défi HMAC SHA-1 ou SHA-256).
- Selon la passerelle, l’adresse IP de Gladys doit figurer dans la liste des adresses autorisées (« IP range »)
  de MyHOME_Suite.

## Configuration

- **Adresse de la passerelle** et **port**.
- **Mot de passe OPEN** : gardé par Gladys dans sa base, jamais réaffiché, envoyé seulement à la passerelle sous
  forme de réponse à son défi, jamais écrit dans les journaux ni dans `/data`.
- **Variateurs** (facultatif) : les adresses A/PL des variateurs, par ex. `13, 0215, 12#4#01`. Un variateur qui
  donne son niveau est reconnu tout seul.
- **Points lumineux en lecture seule** (facultatif) : les actionneurs à ne jamais commander depuis Gladys (pompe,
  VMC, radiateur sur relais…). Une lumière obéit aux assistants vocaux, aux scènes et à « tout éteindre » : listez
  ici ce qui ne doit jamais être coupé ainsi, puis supprimez son ancienne fonctionnalité dans Gladys.
- **Zones de chauffage** (facultatif) : les numéros 1 à 99. Une zone qui donne sa température est reconnue toute
  seule.
- **Thermostats** : « Centrale » (centrale 3550, 99 ou 4 zones : les commandes passent par elle) ou « Thermostats
  autonomes ».
- **Autoriser le réglage des consignes depuis Gladys** : désactivé par défaut (voir « Chauffage »).

Une entrée non comprise dans les listes est ignorée et comptée dans l’état de l’intégration (sans être
réaffichée).

## Les appareils

Cliquez sur « Rechercher » dans l’onglet Découverte. L’intégration lit l’installation (état de tous les points
lumineux et de tous les volets, niveau des variateurs, température, consigne et mode des zones) et propose :

- **Point lumineux** : allumé / éteint ; avec la **luminosité** pour un variateur. Un point en lecture seule n’a
  qu’un état.
- **Volet** : ouvrir / fermer / arrêter ; avec la **position** (0 fermé à 100 ouvert) pour un volet qui la donne
  (volets « avancés »).
- **Zone de chauffage** : température, consigne, mode (arrêt, chauffage manuel, climatisation manuelle,
  automatique).

L’identifiant d’un appareil est son adresse OpenWebNet (`light:12`, `shutter:0215`, `zone:3` ; un point derrière
une interface `12#4#01` devient `12-4-01`) : il ne change jamais.

Les changements faits sur l’installation (boutons, application, programme) arrivent par la session d’événements
de la passerelle. L’installation est relue entière toutes les 10 minutes, jamais deux fois en moins d’une minute
(redémarrage, reconnexion et bouton compris). Une valeur de plus de 2 heures n’est plus publiée.

## Les commandes

L’intégration ouvre **une seule session de commande à la fois**, une requête à la fois. Chaque commande est
écrite dans les 2,5 s ou pas du tout, puis l’appareil est relu : Gladys reçoit sa réponse dans les 3,3 s :

- **confirmée** : la relecture montre la valeur demandée ;
- **non envoyée** (rien n’est parti) : passerelle injoignable, occupée trop longtemps, file pleine, ou remplacée
  par un arrêt arrivé après elle ;
- **refusée par la passerelle** (NACK) : rien n’a été fait ;
- **envoyée, sans confirmation** : partie, mais la relecture ne montre pas encore la valeur ; l’appareil est
  relu 5 s et 20 s plus tard.

Avant la première commande d’une session, l’adresse MAC de la passerelle est lue : une autre passerelle à la
même adresse arrête les commandes jusqu’au clic sur « Tester la connexion ».

### L’extinction, l’arrêt du volet, l’arrêt du chauffage

Éteindre une lumière (ou un variateur à 0), arrêter un volet et arrêter une zone de chauffage passent avant tout
le reste : ils ne dépendent d’aucune option, d’aucune relecture préalable, ni de la lecture de l’adresse MAC. Une
lecture que la passerelle laisse sans réponse depuis 1 s est coupée pour eux ; les commandes du même appareil
encore en attente sont annulées (rien de demandé avant un arrêt ne part après lui).

S’ils ne peuvent pas partir, ils sont réessayés toutes les 250 ms pendant 3,3 s, puis **gardés dans `/data`** et
renvoyés dès que la passerelle répond (au redémarrage aussi), 3 fois au plus et pendant 10 minutes au plus. Un
arrêt gardé est abandonné si une commande plus récente du même appareil est partie, ou si l’appareil a changé
sur l’installation entre-temps (un bouton, l’application) : il n’arrête jamais un mouvement lancé ensuite par
quelqu’un d’autre. Une extinction ou un arrêt que la relecture contredit (la lumière encore allumée, le volet
qui bouge encore) est renvoyé une fois, dans les 3,3 s.

Ils sont refusés seulement dans ces cas :

- l’intégration n’a pas encore d’adresse de passerelle ;
- la connexion est arrêtée : mot de passe refusé, passerelle qui demande un mot de passe absent ou n’acceptant qu’un
  mot de passe numérique, passerelle qui n’a pas prouvé connaître le mot de passe, autre passerelle à cette adresse (le
  mot de passe refusé n’est jamais renvoyé tout seul) ;
- le point est en lecture seule dans la configuration ;
- la valeur demandée n’est pas valable ;
- la passerelle répond NACK à chaque essai pendant 3,3 s.

### Chauffage

Changer la consigne d’une zone (5 à 40 °C, au demi-degré) ou la remettre en **automatique** (le programme de la
centrale) est **désactivé par défaut**. Une fois autorisé, l’option est revérifiée à la demande, après la
relecture de la zone et juste avant l’écriture ; la zone est relue juste avant (si elle ne répond pas, rien n’est
envoyé) ; une consigne égale à celle relue n’est pas réécrite. Ces commandes sont refusées pendant l’arrêt de la
zone. « Chauffage » ou « Climatisation » ne se choisissent pas dans le mode : réglez une consigne. Un thermostat
autonome n’a pas d’« Automatique ».

**Arrêter une zone** (mode « Arrêt ») ne dépend jamais de l’option (ses seuls refus sont listés plus haut).

## Le mot de passe

- Un mot de passe refusé arrête la connexion : plus aucun essai tant que le mot de passe ne change pas ou que
  « Tester la connexion » n’est pas cliqué. Deux sessions fermées par la passerelle juste après le mot de passe
  comptent comme un refus. Ce refus est retenu dans `/data` par une marque de 8 bits salée (jamais le mot de
  passe) : un redémarrage ne renvoie pas le même mot de passe.
- Avec le défi HMAC, la passerelle doit prouver qu’elle connaît le mot de passe ; sinon la connexion s’arrête.

## État et pannes

L’état de l’intégration dit « Connectée » seulement quand la session d’événements est ouverte et que la
passerelle a répondu à une lecture. Une passerelle injoignable est réessayée après 10 s, 30 s, 1 min, 2 min puis
toutes les 5 min. Si `/data` est illisible, il n’est jamais écrasé et il est relu toutes les 10 s.

## Limites

- Pas de scénarios (CEN, WHO 15/25), d’énergie (WHO 18), d’alarme, de serrures ni de portails en v1.
- Les volets « avancés » sans position connue n’ont que ouvrir / fermer / arrêter tant qu’ils n’ont pas donné
  leur position.
- La passerelle limite le nombre de sessions ouvertes : l’intégration en garde normalement deux (événements
  et commandes), la session de commande se ferme après 20 s sans requête.

## Source

Le code est sur <https://github.com/LM1LC3N7/gladys-bticino-myhome> (Apache-2.0). Il porte en JavaScript une
partie d’OWNd (OpenWebNet-HA, Apache-2.0 depuis le 2026-09-29), voir `THIRD_PARTY_NOTICES.md`.
