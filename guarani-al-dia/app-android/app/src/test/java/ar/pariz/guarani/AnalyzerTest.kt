package ar.pariz.guarani
import org.junit.Assert.*
import org.junit.Test
class AnalyzerTest {
    private val txt = """
Historia Académica
Promedio general con aplazos: 9,60
Instrumentos y Mediciones (GSTI-106)
14/11/2026 Examen 8 (Ocho) Aprobado
Legislación en Tecnologías de la Información y Comunicaciones (GSTI-104)
En curso
Estadísticas y Probabilidad (GSTI-103)
20/06/2026 Regularidad 10 (Diez) Regular
Base de Datos (GSTI-107)
11/10/2026 Promoción 10 (Diez) Promocionado
Fronteras y Desarrollo (DDF-4)
15/11/2026 Aprobado Nota: A
Última conexión 12/11/2026 13:10
""".trimIndent()
    private val names = listOf("Instrumentos y Mediciones","Legislación en Tecnologías de la Información y Comunicaciones",
        "Estadísticas y Probabilidad","Base de Datos","Fronteras y Desarrollo")
    @Test fun grades() {
        val l = Analyzer.lines(txt)
        assertFalse(l.any { it.contains("conexión") })
        assertEquals("aprobada" to "8", Analyzer.findGrade(l, "Instrumentos y Mediciones", names))
        assertNull(Analyzer.findGrade(l, "Legislación en Tecnologías de la Información y Comunicaciones", names))
        assertEquals("regular" to "10", Analyzer.findGrade(l, "Estadísticas y Probabilidad", names))
        assertEquals("promocionada" to "10", Analyzer.findGrade(l, "Base de Datos", names))
        assertEquals("aprobada" to "A", Analyzer.findGrade(l, "Fronteras y Desarrollo", names))
    }
}
