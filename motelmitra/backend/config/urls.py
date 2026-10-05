from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path
from rest_framework.routers import DefaultRouter
from rest_framework_simplejwt.views import TokenRefreshView

from accounts.views import ClientViewSet, LoginView, UserViewSet, me, motel_settings, version
from motel import views as mv

router = DefaultRouter()
router.register("clients", ClientViewSet, basename="client")
router.register("users", UserViewSet, basename="user")
router.register("room-types", mv.RoomTypeViewSet, basename="room-type")
router.register("rooms", mv.RoomViewSet, basename="room")
router.register("guests", mv.GuestViewSet, basename="guest")
router.register("stays", mv.StayViewSet, basename="stay")
router.register("notes", mv.NoteViewSet, basename="note")
router.register("expenses", mv.ExpenseViewSet, basename="expense")
router.register("photos", mv.PhotoViewSet, basename="photo")

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/auth/login/", LoginView.as_view()),
    path("api/auth/refresh/", TokenRefreshView.as_view()),
    path("api/auth/me/", me),
    path("api/version/", version),
    path("api/settings/", motel_settings),
    path("api/dashboard/", mv.dashboard),
    path("api/business-day/", mv.business_day),
    path("api/photo-sessions/", mv.photo_session_create),
    path("api/photo-sessions/<str:token>/", mv.photo_session_status),
    path("api/scanner/test/", mv.scanner_test),
    path("api/scanner/scan/", mv.scanner_scan),
    path("api/scanner/folder/", mv.scanner_folder),
    path("api/scanner/folder/file/", mv.scanner_folder_file),
    path("api/phone/<str:token>/", mv.phone_info),
    path("api/phone/<str:token>/upload/", mv.phone_upload),
    path("api/business-day/preview/", mv.business_day_preview),
    path("api/business-day/close/", mv.business_day_close),
    path("api/business-day/reopen/", mv.business_day_reopen),
    path("api/business-day/history/", mv.business_day_history),
    path("api/maintenance/", mv.maintenance_board),
    path("api/reports/today/", mv.report_today),
    path("api/reports/checkins/", mv.report_checkins),
    path("api/reports/collections/", mv.report_collections),
    path("api/reports/outstanding/", mv.report_outstanding),
    path("api/reports/occupancy/", mv.report_occupancy),
    path("api/reports/payment-history/", mv.report_payment_history),
    path("api/", include(router.urls)),
] + static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
