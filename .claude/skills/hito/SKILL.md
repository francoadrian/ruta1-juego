---
name: hito
description: Ejecuta un hito completo de la hoja de ruta de Ruta 1 (diseño → implementación → verificación → auditoría → commit en una rama), coordinando los agentes del proyecto. Lo invoca el usuario con /hito <número o descripción>.
disable-model-invocation: true
argument-hint: <número de hito o descripción>
---

# /hito $ARGUMENTS

Coordinás un hito de la hoja de ruta de `CLAUDE.md` usando los agentes de `.claude/agents/`. Vos (la sesión principal) orquestás: no implementes en persona lo que le corresponde a un agente, salvo ajustes chicos de integración.

## 0. Preparar
- Identificá el hito a partir de `$ARGUMENTS` (un número 1–3 de la hoja de ruta, o una descripción libre). Si es ambiguo, preguntá antes de seguir.
- Chequeá que el árbol de git esté limpio. Si no lo está, preguntá qué hacer con los cambios.
- Corré `python tools/backup_db.py` (los hitos pueden migrar la DB).
- Creá una rama `hito-<n>-<slug>` desde `main`.

## 1. Diseño — `arquitecto`
- Si ya existe un ADR para este hito en `docs/adr/`, leelo y preguntale al usuario si se rehace o se usa ese.
- Si no, lanzá `arquitecto` con el objetivo del hito.
- Mostrale al usuario el resumen del ADR **y sus preguntas abiertas**. **Pará y esperá la aprobación** antes de implementar. Si cambia algo, volvé a lanzar `arquitecto` para que actualice el ADR.

## 2. Implementación
- Tomá el plan por pasos del ADR. Para cada paso, lanzá el agente que indica (`motor-tcg`, `backend-api` o `contenido`) con la ruta del ADR y **solo ese paso**.
- Los pasos que el ADR marca como independientes y no comparten archivos van en paralelo (varios agentes en el mismo mensaje). Los demás, en orden.
- Los pasos sin agente asignado (por ejemplo, UI) los hacés vos.
- Después de cada tanda, revisá el diff (`git diff --stat` y una lectura rápida) para confirmar que cada agente respetó su alcance.

## 3. Verificación — `verificador`
- Lanzá `verificador` describiéndole qué cambió y qué ejercitar.
- Si falla, devolvele la falla al agente que implementó esa parte, y después volvé a verificar. Si después de 2 vueltas sigue fallando, pará y explicale al usuario.

## 4. Auditoría — `auditor-seguridad`
- Lanzá `auditor-seguridad` sobre los cambios de la rama (`git diff main...HEAD`).
- Los hallazgos Críticos y Altos se arreglan con el agente correspondiente y se vuelve a verificar, **salvo que el arreglo cambie el comportamiento del juego o algo que pidió el usuario**: en ese caso, se le muestran las opciones al usuario para que decida. Los Medios y Bajos, y la sección "Para que decida el usuario", se le muestran al usuario para que decida. Nunca se aplica por cuenta propia una restricción de diseño (premios, recompensas, límites de juego).

## 5. Cierre
- Hacé commits en la rama: uno por paso lógico, con mensaje en español.
- **No mergees ni pushees** sin que el usuario lo pida.
- Resumen final para el usuario: qué se hizo, ADR, rama, veredicto del verificador y del auditor, y qué quedó pendiente.

## Ahorro de tokens
- No releas archivos que un agente ya resumió. Confiá en su reporte y verificá con el diff.
- A cada agente pasale la ruta del ADR y el paso concreto. No pegues el ADR entero ni reexpliques el proyecto.
