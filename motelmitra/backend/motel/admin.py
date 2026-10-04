from django.contrib import admin

from .models import Guest, Note, Payment, Room, RoomType, Stay


@admin.register(RoomType)
class RoomTypeAdmin(admin.ModelAdmin):
    list_display = ("name", "client", "default_rate", "is_active")
    list_filter = ("client",)


@admin.register(Room)
class RoomAdmin(admin.ModelAdmin):
    list_display = ("number", "room_type", "client", "is_active")
    list_filter = ("client", "room_type")


@admin.register(Guest)
class GuestAdmin(admin.ModelAdmin):
    list_display = ("name", "phone", "license_plate", "client", "do_not_rent")
    list_filter = ("client", "do_not_rent")
    search_fields = ("name", "phone", "license_plate")


class PaymentInline(admin.TabularInline):
    model = Payment
    extra = 0


@admin.register(Stay)
class StayAdmin(admin.ModelAdmin):
    list_display = ("guest", "room", "check_in_date", "check_out_date", "total_amount", "status", "is_deleted")
    list_filter = ("client", "status", "is_deleted")
    inlines = [PaymentInline]


@admin.register(Note)
class NoteAdmin(admin.ModelAdmin):
    list_display = ("date", "room", "text", "created_by", "client")
    list_filter = ("client", "date")
